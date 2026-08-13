// Media Foundation 解码后端（C++ N-API addon）。
//
// 路线 A（彻底去 GPL）：用 Windows 系统自带的 Media Foundation
// （IMFSourceReader）做音视频解码，不再随包分发 mpv.exe / ffmpeg.exe。
// 专利责任随系统授权转移给 Microsoft。
//
// 设计要点（与 ffprobe+MediaPipeline 保持同形，使主进程控制面零改动）：
//   - 视频输出 NV12（MF 最原生格式）→ 原生层解交织成 I420(yuv420p)，
//     渲染端 WebGL2 的 yuv420p 路径零改动复用。
//   - 音频输出 32-bit float PCM；变速用「输出采样率 = 48000/speed」实现
//     （与 ffmpeg atempo 使用同一套 PTS 公式：pts = startTime + 输出帧数/48000*speed，
//     区别是 MF 方案会随倍速改变音高——1.0 已知限制，保留音高的变速需 WSOLA）。
//   - 解码在独立工作线程进行，通过 N-API ThreadSafeFunction 把裸帧/音频回传
//     主线程的 JS 回调；背压由 setThrottle 暂停对应流的读取实现。
//
// 仅 Windows 可编译（链接 mfplat/mfuuid/mf/ole32/oleaut32）。

#include <napi.h>
#include <windows.h>
#include <objbase.h>
#include <propidl.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfobjects.h>
#include <comdef.h>
#include <cstdint>
#include <vector>
#include <string>
#include <atomic>
#include <thread>
#include <chrono>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

namespace {

#ifndef MF_E_INVALIDSTREAMNUMBER
#define MF_E_INVALIDSTREAMNUMBER static_cast<HRESULT>(0xC00D36B9L)
#endif

constexpr int EV_VIDEO = 0;
constexpr int EV_AUDIO = 1;
constexpr int EV_EOS   = 2;
constexpr int EV_ERROR = 3;

// 跨线程传递的事件描述（通过 ThreadSafeFunction 的指针搬运，data 由 JS 侧 finalizer 释放）。
struct FrameEvent {
  int type = 0;
  double pts = 0;
  int frames = 0;
  int sampleRate = 48000;
  int channels = 2;
  int width = 0;
  int height = 0;
  bool decodeError = false;
  void* data = nullptr;     // 音频/视频片:malloc 分配,由 TSFN 回调 Copy 后 free
  size_t size = 0;
  int chunkIndex = 0;       // 保留(分片方案已弃用)
  int chunkCount = 1;       // 保留
  int64_t frameId = -1;     // 视频帧槽位(TSFN 只发信号,数据由 JS 主动 readFrame 拉取)
  int poolIndex = -1;       // 保留(外部缓冲池方案在 electron 不可用)
  std::string message;
};

// 主线程回调（供 TypedThreadSafeFunction 的 CallJs 模板参数使用）。
// 四参签名 (Env, Function, void* context, FrameEvent*) 正是 node-addon-api 类型化 TSFN 的 CallJs 契约，
// 因此 New() 的第六个参数才是 ContextType* context（此处恒传 nullptr）。
static void TsfnCallback(Napi::Env env, Napi::Function jsCb, void* /*context*/, FrameEvent* ev);

// 类型化 TSFN：ContextType=void（无需业务上下文）、DataType=FrameEvent、CallJs=TsfnCallback。
// 这样 TsfnCallback 直接作为主线程回调，NonBlockingCall(ev) 只需传 FrameEvent*，不必再重复传回调指针。
using TsfnType = Napi::TypedThreadSafeFunction<void, FrameEvent, TsfnCallback>;

// ThreadSafeFunction 在主线程回调：把 FrameEvent 翻译成 JS 对象并调用分发函数。
// 2026-08 修复：整个回调包 try/catch（NAPI_CPP_EXCEPTIONS 已开）——TSFN 回调里 JS
// 侧抛异常时，node-addon-api 尝试 Error::New 转错误可能因无 pending error 而 Fatal
// （FATAL ERROR: Error::New napi_get_last_error_info，实测第 5 帧后崩、解码事件全断）。
// 吞掉异常 + 打印诊断，保证解码线程事件不断流。delete ev 放 catch 外，任何路径都释放。
static void TsfnCallback(Napi::Env env, Napi::Function jsCb, void* /*context*/, FrameEvent* ev) {
  try {
    // TSFN 回调传对象给 JS 必须用 EscapableHandleScope + Escape(HandleScope 内
    // 创建的对象作用域结束即失效,大 Buffer 高频创建时悬空引用会导致
    // napi_create_external_buffer / GC 路径 Fatal)
    Napi::EscapableHandleScope scope(env);
    Napi::Object o = Napi::Object::New(env);

    if (ev->type == EV_VIDEO) {
      o.Set("type", Napi::String::New(env, "video"));
      o.Set("pts", Napi::Number::New(env, ev->pts));
      o.Set("width", Napi::Number::New(env, ev->width));
      o.Set("height", Napi::Number::New(env, ev->height));
      // 2026-08 Pull 方案:TSFN 回调只发 frameId 信号(零大分配),
      // 数据由 JS 侧 readFrame(frameId) 普通 N-API 调用拉取。
      o.Set("frameId", Napi::Number::New(env, static_cast<double>(ev->frameId)));
    } else if (ev->type == EV_AUDIO) {
      o.Set("type", Napi::String::New(env, "audio"));
      o.Set("pts", Napi::Number::New(env, ev->pts));
      o.Set("frames", Napi::Number::New(env, ev->frames));
      o.Set("sampleRate", Napi::Number::New(env, ev->sampleRate));
      o.Set("channels", Napi::Number::New(env, ev->channels));
      o.Set("buffer", Napi::Buffer<uint8_t>::Copy(
          env, static_cast<uint8_t*>(ev->data), ev->size));
      free(ev->data);
      ev->data = nullptr;
    } else if (ev->type == EV_EOS) {
      o.Set("type", Napi::String::New(env, "eos"));
      o.Set("decodeError", Napi::Boolean::New(env, ev->decodeError));
    } else if (ev->type == EV_ERROR) {
      o.Set("type", Napi::String::New(env, "error"));
      o.Set("message", Napi::String::New(env, ev->message));
    }

    jsCb.Call({scope.Escape(o)});
  } catch (const Napi::Error& e) {
    fprintf(stderr, "[mf] TSFN 回调异常(Napi): %s\n", e.what());
  } catch (const std::exception& e) {
    fprintf(stderr, "[mf] TSFN 回调异常(std): %s\n", e.what());
  } catch (...) {
    fprintf(stderr, "[mf] TSFN 回调未知异常\n");
  }
  delete ev;
}

class MediaFoundationReader : public Napi::ObjectWrap<MediaFoundationReader> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MediaFoundationReader", {
      InstanceMethod("open", &MediaFoundationReader::Open),
      InstanceMethod("start", &MediaFoundationReader::Start),
      InstanceMethod("stop", &MediaFoundationReader::Stop),
      InstanceMethod("setThrottle", &MediaFoundationReader::SetThrottle),
      InstanceMethod("getPool", &MediaFoundationReader::GetPool),
      InstanceMethod("readFrame", &MediaFoundationReader::ReadFrame),
    });
    exports.Set("MediaFoundationReader", func);
    return exports;
  }

  MediaFoundationReader(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<MediaFoundationReader>(info) {}

  ~MediaFoundationReader() {
    StopInternal();
    ReleaseReader();
  }

 private:
  // ---- 解码状态 ----
  IMFSourceReader* _reader = nullptr;
  DWORD _videoStreamIndex = MF_SOURCE_READER_FIRST_VIDEO_STREAM;
  DWORD _audioStreamIndex = MF_SOURCE_READER_FIRST_AUDIO_STREAM;
  bool _hasVideo = false, _hasAudio = false;
  int _nativeW = 0, _nativeH = 0;
  int _width = 0, _height = 0;
  int _fpsNum = 25, _fpsDen = 1;
  int _sampleRate = 48000, _channels = 2;
  int64_t _duration = 0;   // 100ns
  std::wstring _path;
  double _startTime = 0;
  double _speed = 1.0;
  int _maxWidth = 1920;
  std::string _hwaccel = "auto";
  int _videoTrack = 0, _audioTrack = 0;
  bool _audioOnly = false;
  bool _decodeError = false;

  // ---- 线程 / 同步 ----
  std::thread _thread;
  std::atomic<bool> _running{false};
  std::atomic<bool> _videoThrottled{false};
  std::atomic<bool> _audioThrottled{false};
  std::atomic<bool> _videoDone{false};
  std::atomic<bool> _audioDone{false};
  TsfnType _tsfn;
  std::atomic<int64_t> _videoFrameIndex{0};
  std::atomic<int64_t> _audioFrameCount{0};
  std::vector<float> _audioStaging;

  // ---- 视频帧外部缓冲池(2026-08)----
  // TSFN 回调里单次创建 >~1.2MB 的 external Buffer 必然触发 Node Fatal
  // (FATAL ERROR: Error::New napi_get_last_error_info,实测 1MB 稳/1.5MB 崩)。
  // 1080p YUV420 帧 3MB 超限——改为:Start(非 TSFN 上下文)预创建 N 个 3MB 外部
  // Buffer,解码线程轮换写入,TsfnCallback 只发 poolIndex 小对象,JS 侧取池并拷贝。
  static constexpr int POOL_SIZE = 16;
  std::vector<Napi::Reference<Napi::Buffer<uint8_t>>> _pool;
  uint8_t* _poolRaw[POOL_SIZE] = {nullptr};  // 裸指针(WorkerLoop 非主线程用,不能调 N-API)
  std::atomic<int> _poolSlot{0};
  size_t _poolFrameSize = 0;
  // ---- 视频帧槽位(2026-08 Pull 方案)----
  // TSFN 回调里创建大 Buffer 必崩(electron 实测 384KB 稳/448KB 崩,且 external
  // buffer 被禁止)——改为:解码线程把帧写入原生侧环形槽位,TSFN 回调只发
  // {frameId} 小信号,JS 侧收到后用 readFrame(frameId) 普通 N-API 调用拉取
  // (普通调用创建 3MB Buffer 已验证安全:100 次全 OK)。槽位轮换,JS 须立即拉取。
  struct FrameSlot { uint8_t* data = nullptr; size_t size = 0; std::atomic<int64_t> id{0}; };
  static constexpr int FRAME_SLOTS = 8;
  FrameSlot _frameSlots[FRAME_SLOTS] = {};
  std::atomic<int> _frameSlotIdx{0};
  std::atomic<int64_t> _frameIdSeq{0};
  Napi::Value ReadFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return env.Null();
    int64_t id = info[0].As<Napi::Number>().Int64Value();
    int slot = static_cast<int>((id - 1) % FRAME_SLOTS);  // 与 WorkerLoop 一致(0-based)
    FrameSlot& s = _frameSlots[slot];
    // 校验:槽位 id 与请求一致(不一致=已被下一轮覆盖/半写,拒绝返回 null)
    if (!s.data || s.size == 0 || s.id.load() != id) return env.Null();
    Napi::Buffer<uint8_t> b = Napi::Buffer<uint8_t>::Copy(env, s.data, s.size);
    return b;
  }
  Napi::Value GetPool(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array arr = Napi::Array::New(env, _pool.size());
    for (size_t i = 0; i < _pool.size(); i++) arr.Set(static_cast<uint32_t>(i), _pool[i].Value());
    return arr;
  }

  // ---------- open ----------
  Napi::Value Open(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (_running) StopInternal();
    ReleaseReader();

    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "open(path) 需要字符串参数").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string pathUtf8 = info[0].As<Napi::String>().Utf8Value();
    _videoTrack = 0; _audioTrack = 0; _maxWidth = 1920; _audioOnly = false;
    _hwaccel = "auto"; _speed = 1.0; _decodeError = false;
    _videoFrameIndex = 0; _audioFrameCount = 0;

    if (info.Length() > 1 && info[1].IsObject()) {
      Napi::Object o = info[1].As<Napi::Object>();
      if (o.Has("videoTrack")) _videoTrack = o.Get("videoTrack").ToNumber().Int32Value();
      if (o.Has("audioTrack")) _audioTrack = o.Get("audioTrack").ToNumber().Int32Value();
      if (o.Has("maxWidth")) _maxWidth = o.Get("maxWidth").ToNumber().Int32Value();
      if (o.Has("audioOnly")) _audioOnly = o.Get("audioOnly").ToBoolean().Value();
      if (o.Has("hwaccel")) _hwaccel = o.Get("hwaccel").As<Napi::String>().Utf8Value();
    }

    int wlen = MultiByteToWideChar(CP_UTF8, 0, pathUtf8.c_str(), -1, nullptr, 0);
    _path.assign(static_cast<size_t>(wlen), 0);
    MultiByteToWideChar(CP_UTF8, 0, pathUtf8.c_str(), -1, &_path[0], wlen);

    HRESULT hr = CreateReader();
    if (FAILED(hr)) {
      Napi::Error::New(env, "无法创建 IMFSourceReader（文件无法打开或格式不支持）").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (FAILED(ConfigureStreams())) {
      Napi::Error::New(env, "枚举/配置媒体流失败").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (_hasVideo && !_audioOnly) {
      if (FAILED(ConfigureVideoOutput())) _hasVideo = false;  // 视频不可用则退化纯音频
    }
    if (_hasAudio) {
      if (FAILED(ConfigureAudioOutput())) _hasAudio = false;
    }
    if (!_hasVideo && !_hasAudio) {
      Napi::Error::New(env, "文件中没有可解码的音视频流").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    Napi::Object meta = Napi::Object::New(env);
    meta.Set("hasVideo", Napi::Boolean::New(env, _hasVideo));
    meta.Set("hasAudio", Napi::Boolean::New(env, _hasAudio));
    meta.Set("width", Napi::Number::New(env, _width));
    meta.Set("height", Napi::Number::New(env, _height));
    meta.Set("fpsNum", Napi::Number::New(env, _fpsNum));
    meta.Set("fpsDen", Napi::Number::New(env, _fpsDen));
    meta.Set("sampleRate", Napi::Number::New(env, _sampleRate));
    meta.Set("channels", Napi::Number::New(env, _channels));
    meta.Set("duration", Napi::Number::New(env, static_cast<double>(_duration) / 1e7));
    return meta;
  }

  // ---------- start ----------
  Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!_reader) {
      Napi::Error::New(env, "reader 尚未打开，请先调用 open()").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (_running) StopInternal();

    double startTime = 0, speed = 1.0;
    bool vThr = false, aThr = false;
    Napi::Function cb;
    if (info.Length() > 0 && info[0].IsFunction()) cb = info[0].As<Napi::Function>();
    if (info.Length() > 1 && info[1].IsObject()) {
      Napi::Object o = info[1].As<Napi::Object>();
      if (o.Has("startTime")) startTime = o.Get("startTime").ToNumber().DoubleValue();
      if (o.Has("speed")) speed = o.Get("speed").ToNumber().DoubleValue();
      if (o.Has("videoThrottled")) vThr = o.Get("videoThrottled").ToBoolean().Value();
      if (o.Has("audioThrottled")) aThr = o.Get("audioThrottled").ToBoolean().Value();
    }

    _startTime = startTime;
    _speed = speed;
    _videoThrottled = vThr;
    _audioThrottled = aThr;
    _videoFrameIndex = 0;
    _audioFrameCount = 0;
    _audioStaging.clear();
    _videoDone = !_hasVideo || _audioOnly;
    _audioDone = !_hasAudio;
    _decodeError = false;

    // 变速需要按新输出采样率重新配置音频类型
    if (_hasAudio) ConfigureAudioOutput();

    // 2026-08: electron 主进程禁止 external buffer——池方案不可用,直接跳过。
    // (独立 node 下 external 可用,但 TSFN 回调大 Buffer 有崩溃阈值;electron
    //  环境以 Copy(内部分配)为准,见 TsfnCallback。)
    _pool.clear();
    _poolFrameSize = 0;
    _poolSlot = 0;

    _tsfn = TsfnType::New(env, cb, "mf-events", 0, 1, nullptr);
    _running = true;
    _thread = std::thread(&MediaFoundationReader::WorkerLoop, this);
    return env.Undefined();
  }

  // ---------- stop ----------
  Napi::Value Stop(const Napi::CallbackInfo& info) {
    StopInternal();
    return info.Env().Undefined();
  }

  // ---------- setThrottle ----------
  Napi::Value SetThrottle(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) return env.Undefined();
    Napi::Object o = info[0].As<Napi::Object>();
    if (o.Has("video")) _videoThrottled = o.Get("video").ToBoolean().Value();
    if (o.Has("audio")) _audioThrottled = o.Get("audio").ToBoolean().Value();
    return env.Undefined();
  }

  // ===================== 内部实现 =====================

  void ReleaseReader() {
    if (_reader) { _reader->Release(); _reader = nullptr; }
  }

  HRESULT CreateReader() {
    ReleaseReader();
    IMFAttributes* attr = nullptr;
    MFCreateAttributes(&attr, 1);
    if (_hwaccel == "no" && attr) {
      // 禁用 DXVA：强制纯软件解码（hwdec=no 时使用）
      attr->SetUINT32(MF_SOURCE_READER_DISABLE_DXVA, 1);
    }
    HRESULT hr = MFCreateSourceReaderFromURL(_path.c_str(), attr, &_reader);
    if (attr) attr->Release();
    return hr;
  }

  HRESULT ConfigureStreams() {
    _hasVideo = false; _hasAudio = false;
    _videoStreamIndex = MF_SOURCE_READER_FIRST_VIDEO_STREAM;
    _audioStreamIndex = MF_SOURCE_READER_FIRST_AUDIO_STREAM;

    int videoCount = 0, audioCount = 0;
    for (DWORD idx = 0; idx < 64; idx++) {
      IMFMediaType* mt = nullptr;
      HRESULT hr = _reader->GetNativeMediaType(idx, 0, &mt);
      if (hr == MF_E_INVALIDSTREAMNUMBER) break;
      if (FAILED(hr)) continue;

      GUID major = GUID_NULL;
      mt->GetMajorType(&major);
      if (major == MFMediaType_Video) {
        if (_videoTrack == videoCount) {
          _videoStreamIndex = idx; _hasVideo = true;
          // 记录原生尺寸 / 帧率（用于输出缩放与 PTS 推算）
          UINT32 nw = 0, nh = 0;
          if (SUCCEEDED(MFGetAttributeSize(mt, MF_MT_FRAME_SIZE, &nw, &nh))) { _nativeW = nw; _nativeH = nh; }
          UINT32 num = 0, den = 0;
          if (SUCCEEDED(MFGetAttributeRatio(mt, MF_MT_FRAME_RATE, &num, &den)) && den) {
            _fpsNum = static_cast<int>(num); _fpsDen = static_cast<int>(den);
          }
        }
        videoCount++;
      } else if (major == MFMediaType_Audio) {
        if (_audioTrack == audioCount) {
          _audioStreamIndex = idx; _hasAudio = true;
          UINT32 ch = 0;
          if (SUCCEEDED(mt->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &ch))) _channels = static_cast<int>(ch);
        }
        audioCount++;
      }
      mt->Release();
    }

    // 选择需要解码的流
    if (_hasVideo && !_audioOnly) _reader->SetStreamSelection(_videoStreamIndex, TRUE);
    if (_hasAudio) _reader->SetStreamSelection(_audioStreamIndex, TRUE);

    // 关闭其余不需要的流，省资源
    for (DWORD idx = 0; idx < 64; idx++) {
      BOOL sel = FALSE;
      if (SUCCEEDED(_reader->GetStreamSelection(idx, &sel)) && sel) {
        if (idx != _videoStreamIndex && idx != _audioStreamIndex) {
          _reader->SetStreamSelection(idx, FALSE);
        }
      }
    }

    // 时长（IMFSourceReader 没有 GetDuration，用 presentation attribute 取）
    _duration = 0;
    PROPVARIANT durVar;
    PropVariantInit(&durVar);
    if (SUCCEEDED(_reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &durVar))) {
      if (durVar.vt == VT_UI8) _duration = static_cast<int64_t>(durVar.uhVal.QuadPart);
      else if (durVar.vt == VT_I8) _duration = durVar.hVal.QuadPart;
    }
    PropVariantClear(&durVar);

    if (_fpsDen <= 0) _fpsDen = 1;
    if (_fpsNum <= 0) _fpsNum = 25;
    return S_OK;
  }

  HRESULT ConfigureVideoOutput() {
    if (!_reader || _videoStreamIndex == MF_SOURCE_READER_FIRST_VIDEO_STREAM) return E_FAIL;

    int w = _nativeW, h = _nativeH;
    if (w <= 0) w = 1280;
    if (h <= 0) h = 720;
    if (_maxWidth > 0 && w > _maxWidth) {
      double r = static_cast<double>(_maxWidth) / static_cast<double>(w);
      w = _maxWidth;
      h = static_cast<int>(static_cast<double>(h) * r);
    }
    w -= w % 2; h -= h % 2;
    if (w < 2) w = 2;
    if (h < 2) h = 2;

    IMFMediaType* outType = nullptr;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(outType, MF_MT_FRAME_SIZE, w, h);
    outType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    outType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);

    HRESULT hr = _reader->SetCurrentMediaType(_videoStreamIndex, nullptr, outType);
    if (FAILED(hr)) { outType->Release(); return hr; }

    // 回查真实协商出的尺寸（MF 可能未按要求缩放）
    IMFMediaType* cur = nullptr;
    if (SUCCEEDED(_reader->GetCurrentMediaType(_videoStreamIndex, &cur))) {
      UINT32 cw = 0, ch = 0;
      if (SUCCEEDED(MFGetAttributeSize(cur, MF_MT_FRAME_SIZE, &cw, &ch)) && cw && ch) {
        _width = static_cast<int>(cw); _height = static_cast<int>(ch);
      } else { _width = w; _height = h; }
      cur->Release();
    } else { _width = w; _height = h; }

    outType->Release();
    return S_OK;
  }

  HRESULT ConfigureAudioOutput() {
    if (!_reader || _audioStreamIndex == MF_SOURCE_READER_FIRST_AUDIO_STREAM) return E_FAIL;

    // 变速：输出采样率 = 48000 / speed（与 ffmpeg atempo 同 PTS 公式；1.0 限制：音高随倍速变化）
    int outRate = static_cast<int>(48000.0 / (_speed > 0.001 ? _speed : 1.0));
    if (outRate < 8000) outRate = 8000;
    if (outRate > 192000) outRate = 192000;

    IMFMediaType* outType = nullptr;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
    outType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, static_cast<UINT32>(outRate));
    outType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, static_cast<UINT32>(_channels));
    outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
    outType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                       static_cast<UINT32>(outRate * _channels * 4));
    outType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, static_cast<UINT32>(_channels * 4));

    HRESULT hr = _reader->SetCurrentMediaType(_audioStreamIndex, nullptr, outType);
    outType->Release();
    if (FAILED(hr)) return hr;

    // 回报给渲染端的采样率恒为 48000（PTS 公式用 48000 归算，已对倍速补偿）
    _sampleRate = 48000;
    return S_OK;
  }

  void WorkerLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // seek 到起始时间（100ns 单位）
    if (_startTime > 0.001) {
      PROPVARIANT var;
      PropVariantClear(&var);
      var.vt = VT_I8;
      var.hVal.QuadPart = static_cast<LONGLONG>(_startTime * 1e7);
      _reader->SetCurrentPosition(GUID_NULL, var);
      PropVariantClear(&var);
    }

    while (_running.load()) {
      bool did = false;
      if (_hasVideo && !_audioOnly && !_videoThrottled.load() && !_videoDone.load()) {
        if (ReadStream(_videoStreamIndex, true)) did = true;
      }
      if (_hasAudio && !_audioThrottled.load() && !_audioDone.load()) {
        if (ReadStream(_audioStreamIndex, false)) did = true;
      }

      bool videoComplete = (!_hasVideo || _audioOnly) || _videoDone.load();
      bool audioComplete = !_hasAudio || _audioDone.load();
      if (videoComplete && audioComplete) {
        FlushAudioStaging();
        EmitEos();
        break;
      }

      if (!did) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    _running = false;
    CoUninitialize();
  }

  bool ReadStream(DWORD idx, bool isVideo) {
    DWORD actual = 0, flags = 0;
    LONGLONG time = 0;
    IMFSample* sample = nullptr;
    HRESULT hr = _reader->ReadSample(idx, 0, &actual, &flags, &time, &sample);
    if (FAILED(hr)) {
      _decodeError = true;
      EmitError("ReadSample 失败（解码中断）");
      _videoDone = true; _audioDone = true;
      return false;
    }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
      if (isVideo) _videoDone = true; else _audioDone = true;
      if (sample) sample->Release();
      return false;
    }
    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
      // 类型中途切换（极少数封装）：重新配置输出类型
      if (isVideo) ConfigureVideoOutput(); else ConfigureAudioOutput();
    }
    if (!sample) return true;  // 需要继续读取

    if (isVideo) ProcessVideoSample(sample, time);
    else ProcessAudioSample(sample, time);
    sample->Release();
    return true;
  }

  void ProcessVideoSample(IMFSample* sample, LONGLONG /*time*/) {
    IMFMediaBuffer* buf = nullptr;
    if (FAILED(sample->GetBufferByIndex(0, &buf))) return;

    BYTE* p0 = nullptr;
    LONG stride = 0;
    bool locked2d = false;
    IMF2DBuffer* p2d = nullptr;
    if (SUCCEEDED(buf->QueryInterface(IID_IMF2DBuffer, reinterpret_cast<void**>(&p2d)))) {
      if (SUCCEEDED(p2d->Lock2D(&p0, &stride))) locked2d = true;
      p2d->Release();
    }
    if (!locked2d) {
      if (FAILED(buf->Lock(&p0, nullptr, nullptr))) { buf->Release(); return; }
    }
    if (stride == 0) stride = _width;

    const int w = _width, h = _height;
    const int cw = w / 2, ch = h / 2;
    const size_t ySize = static_cast<size_t>(w) * h;
    const size_t uvSize = static_cast<size_t>(cw) * ch;
    const size_t total = ySize + 2 * uvSize;

    // 2026-08: electron 禁止 external buffer,池不可用——回退每帧 malloc,
    // TSFN 回调里 Copy 成 Node 内部分配的 Buffer(见 TsfnCallback)。
    uint8_t* out = static_cast<uint8_t*>(malloc(total));
    if (!out) {
      buf->Unlock(); buf->Release();
      return;
    }

    // Y 平面：逐行拷贝（考虑 stride 对齐）
    uint8_t* Y = out;
    for (int y = 0; y < h; y++) {
      memcpy(Y + static_cast<size_t>(y) * w, p0 + static_cast<size_t>(y) * stride, static_cast<size_t>(w));
    }
    // NV12 → I420：解交织 UV（UV 行跨距 = Y 行跨距）
    const uint8_t* uv = p0 + static_cast<size_t>(stride) * h;
    uint8_t* U = out + ySize;
    uint8_t* V = U + uvSize;
    for (int y = 0; y < h; y++) {
      int cy = y / 2;
      const uint8_t* srow = uv + static_cast<size_t>(cy) * stride;
      uint8_t* urow = U + static_cast<size_t>(cy) * cw;
      uint8_t* vrow = V + static_cast<size_t>(cy) * cw;
      for (int x = 0; x < w; x++) {
        int cx = x >> 1;
        urow[cx] = srow[2 * cx];
        vrow[cx] = srow[2 * cx + 1];
      }
    }

    if (locked2d) {
      // 重新取 2D 接口解锁（上面已 Release，这里重新 Query）
      IMF2DBuffer* p2d2 = nullptr;
      if (SUCCEEDED(buf->QueryInterface(IID_IMF2DBuffer, reinterpret_cast<void**>(&p2d2)))) {
        p2d2->Unlock2D();
        p2d2->Release();
      }
    } else {
      buf->Unlock();
    }
    buf->Release();

    double fps = static_cast<double>(_fpsNum) / static_cast<double>(_fpsDen);
    if (fps < 1) fps = 1;
    // 视频 PTS 不含 speed 因子——与 ffmpeg 管线的 MediaPipeline 完全一致
    // （pts = startTime + frameIndex/fps）。变速由音频主时钟与渲染端丢帧逻辑
    // 统一处理，避免视频/音频在变速时错位。沿用 MediaPipeline 的契约，
    // 渲染端对两者零差别。
    double pts = _startTime + (static_cast<double>(_videoFrameIndex.load()) / fps);
    _videoFrameIndex++;

    // 2026-08 Pull 方案:帧写入原生侧环形槽位,TSFN 只发 frameId 信号,
    // JS 收到后用 readFrame(frameId) 拉取(TSFN 回调内创建大 Buffer 必崩)。
    int64_t id = _frameIdSeq.fetch_add(1) + 1;
    int slot = static_cast<int>((id - 1) % FRAME_SLOTS);
    FrameSlot& fs = _frameSlots[slot];
    if (!fs.data || fs.size < total) {
      free(fs.data);
      fs.data = static_cast<uint8_t*>(malloc(total));
      fs.size = fs.data ? total : 0;
    }
    if (fs.data) {
      memcpy(fs.data, out, total);
      fs.id.store(id);  // 写完再标记 id(readFrame 校验防半写)
      FrameEvent* ev = new FrameEvent{};
      ev->type = EV_VIDEO;
      ev->pts = pts;
      ev->width = w;
      ev->height = h;
      ev->frameId = id;
      if (_tsfn) _tsfn.NonBlockingCall(ev);
    }
    free(out);
  }

  void ProcessAudioSample(IMFSample* sample, LONGLONG /*time*/) {
    IMFMediaBuffer* buf = nullptr;
    if (FAILED(sample->GetBufferByIndex(0, &buf))) return;

    BYTE* p0 = nullptr;
    DWORD maxLen = 0, curLen = 0;
    if (FAILED(buf->Lock(&p0, &maxLen, &curLen))) { buf->Release(); return; }

    const int ch = _channels;
    int frames = static_cast<int>(curLen / (static_cast<size_t>(ch) * 4));
    const float* src = reinterpret_cast<const float*>(p0);
    for (int i = 0; i < frames * ch; i++) _audioStaging.push_back(src[i]);

    buf->Unlock();
    buf->Release();

    const int framesPerChunk = 2048;
    while (static_cast<int>(_audioStaging.size() / ch) >= framesPerChunk) {
      size_t nbytes = static_cast<size_t>(framesPerChunk) * ch * 4;
      float* out = static_cast<float*>(malloc(nbytes));
      if (!out) break;
      memcpy(out, _audioStaging.data(), nbytes);
      _audioStaging.erase(_audioStaging.begin(),
                          _audioStaging.begin() + static_cast<size_t>(framesPerChunk) * ch);

      double pts = _startTime + (static_cast<double>(_audioFrameCount.load()) / 48000.0) * _speed;
      _audioFrameCount += framesPerChunk;

      FrameEvent* ev = new FrameEvent{};
      ev->type = EV_AUDIO;
      ev->pts = pts;
      ev->frames = framesPerChunk;
      ev->sampleRate = _sampleRate;   // 恒为 48000
      ev->channels = ch;
      ev->data = out;
      ev->size = nbytes;
      if (_tsfn) _tsfn.NonBlockingCall(ev);
    }
  }

  void FlushAudioStaging() {
    const int ch = _channels;
    int avail = static_cast<int>(_audioStaging.size() / ch);
    if (avail <= 0) return;
    size_t nbytes = static_cast<size_t>(avail) * ch * 4;
    float* out = static_cast<float*>(malloc(nbytes));
    if (!out) return;
    memcpy(out, _audioStaging.data(), nbytes);
    _audioStaging.clear();

    double pts = _startTime + (static_cast<double>(_audioFrameCount.load()) / 48000.0) * _speed;
    _audioFrameCount += avail;

    FrameEvent* ev = new FrameEvent{};
    ev->type = EV_AUDIO;
    ev->pts = pts;
    ev->frames = avail;
    ev->sampleRate = _sampleRate;
    ev->channels = ch;
    ev->data = out;
    ev->size = nbytes;
    if (_tsfn) _tsfn.NonBlockingCall(ev);
  }

  void EmitEos() {
    FrameEvent* ev = new FrameEvent{};
    ev->type = EV_EOS;
    ev->decodeError = _decodeError;
    if (_tsfn) _tsfn.NonBlockingCall(ev);
  }

  void EmitError(const char* msg) {
    FrameEvent* ev = new FrameEvent{};
    ev->type = EV_ERROR;
    ev->message = msg ? msg : "";
    if (_tsfn) _tsfn.NonBlockingCall(ev);
  }

  void StopInternal() {
    _running = false;
    if (_thread.joinable()) _thread.join();
    if (_tsfn) {
      _tsfn.Abort();
      _tsfn.Release();
    }
    // 2026-08: 释放视频帧外部缓冲池(Reference 析构 → Buffer 释放 → finalizer free)
    _pool.clear();
    _poolFrameSize = 0;
    _poolSlot = 0;
    // 释放视频帧槽位
    for (int i = 0; i < FRAME_SLOTS; i++) {
      free(_frameSlots[i].data);
      _frameSlots[i].data = nullptr;
      _frameSlots[i].size = 0;
    }
  }
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
  MediaFoundationReader::Init(env, exports);
  return exports;
}

}  // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, InitAll)
