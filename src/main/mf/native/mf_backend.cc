// Media Foundation 解码后端（C++ N-API addon）。
//
// 路线 A（彻底去 GPL）：用 Windows 系统自带的 Media Foundation
// （IMFSourceReader）做音视频解码，不再随包分发 mpv.exe / ffmpeg.exe。
// 专利责任随系统授权转移给 Microsoft。
//
// 设计要点（与 ffprobe+MediaPipeline 保持同形，使主进程控制面零改动）：
//   - 视频输出 NV12（MF 最原生格式）→ 原生层解交织成 I420(yuv420p)，
//     渲染端 WebGL2 的 yuv420p 路径零改动复用。
//   - 音频输出 32-bit float PCM，采样率恒为 48000（不变调）。变速保音高改由
//     渲染端 AudioWorklet 的 WSOLA 完成（pts = startTime + 输出帧数/48000，
//     speed 仅影响消费侧时间伸缩，不进入 PTS）；ffmpeg 引擎则在解码侧用 atempo
//     已保音高、消费侧直出。两种引擎 PTS 公式统一为 startTime + frames/48000。
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
#include <cstdlib>
#include <cmath>
#include <vector>
#include <string>
#include <atomic>
#include <thread>
#include <chrono>

// MFSampleExtension_Device：硬件 MFT 解码出的 sample 会带此属性 GUID；软件回退则不带。
// 用于观测 DXVA/D3D11 是否真正生效。个别 Windows SDK 分区下该符号未被 mfapi.h 暴露，
// 这里手动定义（值取自 Windows SDK），避免编译期 "未声明的标识符"。
static const GUID MF_SampleExtension_Device_GUID = {
  0xb2bfa0ad, 0x7e6c, 0x41fd, { 0xa1, 0x2b, 0xf3, 0x42, 0xc2, 0xd1, 0x38, 0x24 }
};

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
constexpr int EV_HWACCEL = 4;   // 首帧硬件解码状态观测（DXVA/D3D11 回退可观测）

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
  const char* hwaccel = nullptr;  // EV_HWACCEL：实际生效的硬件加速状态（"d3d11"/"software"）
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
// TSFN 上下文:每次 start 新分配一个(旧 TSFN 的残留事件持旧 context,
// StopInternal 时置 stopped=true → 残留回调直接丢弃,不碰 N-API)。
// 旧 context 在旧 TSFN 残留清空前保持存活(泄漏 16B/次 start,可忽略)。
struct TsfnCtx {
  std::atomic<bool> stopped{false};
};

// ThreadSafeFunction 在主线程回调：把 FrameEvent 翻译成 JS 对象并调用分发函数。
// 2026-08 修复：整个回调包 try/catch（NAPI_CPP_EXCEPTIONS 已开）——TSFN 回调里 JS
// 侧抛异常时，node-addon-api 尝试 Error::New 转错误可能因无 pending error 而 Fatal
// （FATAL ERROR: Error::New napi_get_last_error_info，实测第 5 帧后崩、解码事件全断）。
// 吞掉异常 + 打印诊断，保证解码线程事件不断流。delete ev 放 catch 外，任何路径都释放。
// 2026-08 二次修复:stop/seek 重载后,旧 TSFN 已 Abort/Release 但主线程队列里残留的
// FrameEvent 仍会执行回调——此时 env 已不可用,调用任何 N-API(连 Object::New)都
// Fatal(实测:8K 加载切换必现)。context 按 start 代际隔离(per-start 新分配),
// 回调开头检查对应 ctx.stopped,残留项直接丢弃。
static void TsfnCallback(Napi::Env env, Napi::Function jsCb, void* context, FrameEvent* ev) {
  TsfnCtx* ctx = static_cast<TsfnCtx*>(context);
  if (ctx && ctx->stopped.load()) {
    delete ev;
    return;
  }
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
    } else if (ev->type == EV_HWACCEL) {
      o.Set("type", Napi::String::New(env, "hwaccel"));
      o.Set("hwaccel", Napi::String::New(env, ev->hwaccel ? ev->hwaccel : "unknown"));
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
  int _sarNum = 1, _sarDen = 1;   // 源像素宽高比（SAR/PAR）；MF 不自动按 SAR 拉伸，需原生修正
  double _sar = 1.0;
  int _width = 0, _height = 0;   // 解码器原生输出尺寸（MF 必须按源原生尺寸，不能缩放）
  int _trueH = 0;                // 实际解码高度（MF 常把高度补齐到宏块倍数，如 1080→1088）
  int _outW = 0, _outH = 0;      // 实际回报/发送的帧尺寸（>maxWidth 时由拷贝环节降采样得到）
  int _fpsNum = 25, _fpsDen = 1;
  int _sampleRate = 48000, _channels = 2;
  int _outChannels = 2;   // 输出强制立体声（与 ffmpeg 管线 -ac 2 对齐；MF 自动下混/上混）
  int64_t _duration = 0;   // 100ns
  std::wstring _path;
  double _startTime = 0;
  double _speed = 1.0;
  int _maxWidth = 1920;
  std::string _hwaccel = "auto";
  int _videoTrack = 0, _audioTrack = 0;
  bool _audioOnly = false;
  bool _decodeError = false;
  int _vidReadLog = 0;   // 视频 ReadSample 诊断计数（VLOG 用）
  bool _hwDetected = false;   // 首帧硬件解码状态是否已探测
  std::string _hwAccelActual = "pending";  // 实际生效：d3d11 / software
  GUID _videoSubType = GUID_NULL;          // 实际协商出的视频子类型（NV12/P010/NV21/YV12/I420）

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
  // consumed=true 表示槽空闲(初始/已被 readFrame 消费),解码线程可写入;
  // consumed=false 表示槽内仍有未读帧,解码线程必须等待,否则覆盖会丢失该帧
  // (覆盖后 readFrame 校验失败返回 null → 渲染端 upload(null) 抛错 → 视频冻结)。
  struct FrameSlot {
    uint8_t* data = nullptr;
    size_t size = 0;
    std::atomic<int64_t> id{0};
    std::atomic<bool> consumed{true};
  };
  static constexpr int FRAME_SLOTS = 8;
  FrameSlot _frameSlots[FRAME_SLOTS] = {};
  std::atomic<int> _frameSlotIdx{0};
  std::atomic<int64_t> _frameIdSeq{0};
  // 2026-08: 当前 TSFN 的 ctx(per-start 新分配;StopInternal 置 stopped 并清空,
  // 旧 ctx 泄漏至残留回调结束)
  TsfnCtx* _activeCtx = nullptr;
  Napi::Value ReadFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) return env.Null();
    int64_t id = info[0].As<Napi::Number>().Int64Value();
    int slot = static_cast<int>((id - 1) % FRAME_SLOTS);  // 与 WorkerLoop 一致(0-based)
    FrameSlot& s = _frameSlots[slot];
    // 校验:槽位 id 与请求一致(不一致=已被下一轮覆盖/半写,拒绝返回 null)
    if (!s.data || s.size == 0 || s.id.load() != id) return env.Null();
    Napi::Buffer<uint8_t> b = Napi::Buffer<uint8_t>::Copy(env, s.data, s.size);
    s.consumed.store(true);  // 标记已消费,解码线程可复用该槽(否则会被背压闸门挡住)
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
    _hwDetected = false; _hwAccelActual = "pending";
    _videoFrameIndex = 0; _audioFrameCount = 0;
    // 复位帧槽序列号与消费标志:StopInternal 只 free 槽数据,不复位 consumed/id。
    // 若不复位,复播/seek/切歌时旧遗留的 consumed=false 会让背压闸门(WorkerLoop)
    // 误判"槽未消费"而永久跳过视频解码 → 重启后无画面死锁。
    _frameIdSeq = 0;
    for (int i = 0; i < FRAME_SLOTS; i++) {
      _frameSlots[i].id.store(0);
      _frameSlots[i].consumed.store(true);
    }

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
    meta.Set("width", Napi::Number::New(env, _outW));
    meta.Set("height", Napi::Number::New(env, _outH));
    meta.Set("fpsNum", Napi::Number::New(env, _fpsNum));
    meta.Set("fpsDen", Napi::Number::New(env, _fpsDen));
    meta.Set("sampleRate", Napi::Number::New(env, _sampleRate));
    meta.Set("channels", Napi::Number::New(env, _channels));
    meta.Set("sar", Napi::Number::New(env, _sar));
    meta.Set("sarNum", Napi::Number::New(env, _sarNum));
    meta.Set("sarDen", Napi::Number::New(env, _sarDen));
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

    // 2026-08: seek 修复——SetCurrentPosition 必须在读取空闲时调用(旧 WorkerLoop
    // 已 join),且先 Flush 清空旧读取队列,否则位置设置不生效(实测 seek(1) 后
    // 仍在旧位置播放)。Flush 放主线程(Start 调用线程)而非 WorkerLoop——此前在
    // WorkerLoop 里 Flush 会导致 SourceReader 停摆(ReadSample 不再产出)。
    if (_startTime > 0.001) {
      HRESULT hrF = _reader->Flush(MF_SOURCE_READER_ALL_STREAMS);
      PROPVARIANT var;
      PropVariantClear(&var);
      var.vt = VT_I8;
      var.hVal.QuadPart = static_cast<LONGLONG>(_startTime * 1e7);
      HRESULT hrS = _reader->SetCurrentPosition(GUID_NULL, var);
      PropVariantClear(&var);
      fprintf(stderr, "[mf] seek t=%.2f flush=%08x setpos=%08x\n", _startTime, hrF, hrS);
    }
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

    // 2026-08: per-start TSFN 上下文——旧 ctx 由 StopInternal 置 stopped,
    // 残留回调持旧 ctx(泄漏 16B/次,可忽略);新 start 用新 ctx 保证事件正常
    TsfnCtx* ctx = new TsfnCtx();
    _activeCtx = ctx;
    _tsfn = TsfnType::New(env, cb, "mf-events", 0, 1, ctx);
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
          // 读取源像素宽高比（SAR）。MF 默认按存储尺寸解码、不自动拉伸到显示
          // 宽高比；SAR≠1（如 1440x1080 anamorphic，SAR 4:3 → 应显示 16:9）不处理
          // 会导致画面横向拉伸/压扁。原生侧读出 SAR 经 meta 回报给渲染端，由
          // 渲染端 _buildTransform 按 DAR（宽度×SAR）做 contain 适配（原生层
          // 不做缩放，因为 MF 解码器拒绝非原生输出尺寸）。
          UINT32 sarNum = 0, sarDen = 0;
          if (SUCCEEDED(MFGetAttributeRatio(mt, MF_MT_PIXEL_ASPECT_RATIO, &sarNum, &sarDen)) && sarDen) {
            _sarNum = static_cast<int>(sarNum);
            _sarDen = static_cast<int>(sarDen);
            _sar = static_cast<double>(sarNum) / static_cast<double>(sarDen);
          } else {
            _sarNum = 1; _sarDen = 1; _sar = 1.0;
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
    _videoSubType = GUID_NULL;  // 每次打开新文件重置，避免上一文件的协商格式残留

    int w = _nativeW, h = _nativeH;
    if (w <= 0) w = 1280;
    if (h <= 0) h = 720;

    // 关键：MF 的 H.264 解码器不支持输出尺寸缩放——给 SetCurrentMediaType 设
    // 非源原生尺寸会静默失败（返回失败 HRESULT 且 _hasVideo 被置 false，视频轨
    // 整条丢失）。因此 MF 必须按「源原生存储尺寸」输出，SAR（像素宽高比）拉伸
    // 改由渲染端 _buildTransform 按 DAR（宽度×SAR）做 contain 适配（此前在原生
    // 层按 SAR 预拉伸正是 videoEmitted=0 的根因）。
    //
    // 对宽于 maxWidth 的源（2560×1440 / 4K 等），>1920 的部分不再尝试在解码器
    // 端降采样（MF 不接受），改为「解码器保原生 + 拷贝环节降采样」：ProcessVideoSample
    // 把原生 NV12 帧按 maxWidth 做 box 平均下采样到 _outW×_outH 再转 I420 发送，
    // 既修掉「静默丢视频轨」，又保留单帧带宽/显存收益（传输层无硬上限，但 4K 裸帧
    // ~12MB/帧无谓浪费 loopback 带宽与 WebGL 纹理显存）。
    w -= w % 2; h -= h % 2;
    if (w < 2) w = 2;
    if (h < 2) h = 2;

    IMFMediaType* outType = nullptr;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(outType, MF_MT_FRAME_SIZE, w, h);
    // 输出保持源原生存储尺寸（方形像素缓冲），SAR 由渲染端按 DAR 拉伸，
    // 不在此设输出 PIXEL_ASPECT_RATIO（设非原生尺寸 MF 也会失败）。
    outType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    outType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    // 关键：不强制色彩空间。MF 解码器默认按源色彩空间输出（HDR10 源 = BT.2020 + PQ），
    // 渲染端 WebGL 已具备完整 HDR 管线（PQ/SMPTE2084 EOTF 解码 + BT.2390 色调映射 +
    // 自动识别 HDR 显示器/广色域），会按 ffprobe 探到的真实 colorSpace/HDR 信息正确处理。
    // 若此处强加 BT.709，会要求解码器把 HDR10 数据降色到 BT.709，但渲染端仍按源 bt2020+PQ
    // 解码 → 色彩空间冲突 → 画面发绿/过暗。故不再设置矩阵/原色/传输函数，保留源色彩空间。

    HRESULT hr = _reader->SetCurrentMediaType(_videoStreamIndex, nullptr, outType);
    if (FAILED(hr)) { outType->Release(); return hr; }

    // 回查真实协商出的尺寸（MF 可能未按要求缩放）。此处把协商尺寸当作「解码器
    // 原生输出尺寸」_width/_height；实际解码高度可能更大（宏块补齐，如 1080→1088），
    // 由 _trueH 在解码期通过 CURRENTMEDIATYPECHANGED 的再查询捕获。
    IMFMediaType* cur = nullptr;
    if (SUCCEEDED(_reader->GetCurrentMediaType(_videoStreamIndex, &cur))) {
      UINT32 cw = 0, ch = 0;
      if (SUCCEEDED(MFGetAttributeSize(cur, MF_MT_FRAME_SIZE, &cw, &ch)) && cw && ch) {
        _width = static_cast<int>(cw); _height = static_cast<int>(ch);
      } else { _width = w; _height = h; }
      // 记录真实协商出的像素格式，后续 ProcessVideoSample 按实际格式转 I420，
      // 避免 HDR/杜比源解码器给出 P010/NV21 我们却按 NV12 解交织导致紫绿偏色。
      if (FAILED(cur->GetGUID(MF_MT_SUBTYPE, &_videoSubType))) _videoSubType = GUID_NULL;
      fprintf(stderr, "[lumen][mf] ConfigureVideoOutput: negotiated subtype=%s size=%dx%d\n",
              subTypeName(_videoSubType), _width, _height);
      cur->Release();
    } else { _width = w; _height = h; }
    _trueH = _height;

    // 计算「实际回报/发送尺寸」：超 maxWidth 时由拷贝环节降采样到 maxWidth 内。
    _outW = _width; _outH = _height;
    if (_maxWidth > 0 && _width > _maxWidth) {
      _outW = _maxWidth;
      _outH = static_cast<int>(std::round(static_cast<double>(_height) * _maxWidth / _width));
      _outW -= _outW % 2; _outH -= _outH % 2;
      if (_outW < 2) _outW = 2;
      if (_outH < 2) _outH = 2;
    }

    fprintf(stderr, "[lumen][mf] video subtype negotiated: %s (%dx%d -> %dx%d)\n",
            subTypeName(_videoSubType), _width, _height, _outW, _outH);

    outType->Release();
    return S_OK;
  }

  HRESULT ConfigureAudioOutput() {
    if (!_reader || _audioStreamIndex == MF_SOURCE_READER_FIRST_AUDIO_STREAM) return E_FAIL;

    // 输出采样率恒为 48000（原始）。变速保音高改由渲染端 AudioWorklet 的
    // WSOLA 完成（消费侧时域伸缩），不再用"变采样率"实现——那会让音高跟着变。
    int outRate = 48000;

    IMFMediaType* outType = nullptr;
    MFCreateMediaType(&outType);
    outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
    outType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, static_cast<UINT32>(outRate));
    // 强制立体声输出：与 ffmpeg 管线 -ac 2 对齐。MF 在输出类型声道数少于/多于
    // 输入时会自动下混/上混，避免把 5.1/7.1 多声道裸数据直接喂给仅支持双声道的
    // 渲染端 WebGL2/AudioWorklet 路径（否则音频错位或静音）。
    outType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, static_cast<UINT32>(_outChannels));
    outType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 32);
    outType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                       static_cast<UINT32>(outRate * _outChannels * 4));
    outType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, static_cast<UINT32>(_outChannels * 4));

    HRESULT hr = _reader->SetCurrentMediaType(_audioStreamIndex, nullptr, outType);
    outType->Release();
    if (FAILED(hr)) return hr;

    // 回报给渲染端的采样率恒为 48000（PTS 公式用 48000 归算，已对倍速补偿）
    _sampleRate = 48000;
    return S_OK;
  }

  void WorkerLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // 2026-08: seek 位置已在 Start(主线程)通过 Flush+SetCurrentPosition 设置,
    // WorkerLoop 只负责读取(此处不再重复 SetCurrentPosition——旧实现放这里
    // 因读取状态未清而无效,实测 seek 后仍在旧位置)。

    while (_running.load()) {
      bool did = false;
      if (_hasVideo && !_audioOnly && !_videoThrottled.load() && !_videoDone.load()) {
        // 背压闸门:下一个将写入的环形槽若仍未被主线程 readFrame 消费(consumed=false),
        // 说明主线程消费跟不上解码速度,停止继续解码视频,防止环形槽被覆盖丢失帧
        // (覆盖后 readFrame 校验失败返回 null → 渲染端 upload(null) 抛错 → 视频冻结)。
        // 音频解码不受影响,照常推进,不阻断时间轴。
        int64_t nextId = _frameIdSeq.load() + 1;
        int nextSlot = static_cast<int>((nextId - 1) % FRAME_SLOTS);
        if (_frameSlots[nextSlot].consumed.load()) {
          if (ReadStream(_videoStreamIndex, true)) did = true;
        }
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
    if (isVideo && _vidReadLog < 16 && getenv("LUMORA_MF_VLOG")) {
      fprintf(stderr, "[mf-vlog] vidRead#%d hr=0x%08lx flags=0x%08lx sample=%d w=%d h=%d\n",
        _vidReadLog, (unsigned long)hr, (unsigned long)flags, sample ? 1 : 0, _width, _height);
      _vidReadLog++;
    }
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
      // 收到「当前媒体类型已变更」标志时，绝不能再调用 SetCurrentMediaType 重新
      // 设置输出类型——MF 在已开始读取后重设输出类型会重置解码器，下一帧直接返回
      // ENDOFSTREAM（实测 anamorphic / SAR≠1 源因此只解出 1 帧，视频轨整条丢失）。
      // 正确做法只是重新查询实际协商出的尺寸，无需（也不能）再次设置。
      if (isVideo) {
        IMFMediaType* cur = nullptr;
        if (SUCCEEDED(_reader->GetCurrentMediaType(_videoStreamIndex, &cur))) {
          UINT32 cw = 0, ch = 0;
          if (SUCCEEDED(MFGetAttributeSize(cur, MF_MT_FRAME_SIZE, &cw, &ch)) && cw && ch) {
            // 仅更新「实际解码高度」_trueH（用于色度偏移），不要覆盖向渲染端承诺的
            // _height——否则回报尺寸与实际缓冲高度不一致会导致纹理尺寸错配/色彩错位。
            _trueH = static_cast<int>(ch);
          }
          cur->Release();
        }
      } else {
        ConfigureAudioOutput();
      }
    }
    if (!sample) return true;  // 需要继续读取

    if (isVideo) ProcessVideoSample(sample, time);
    else ProcessAudioSample(sample, time);
    sample->Release();
    return true;
  }

  // box 平均降采样单平面（亮度 Y）。源尺寸 srcW×srcH，输出 dstW×dstH，行跨距
  // srcStride（MF 缓冲常含对齐 padding）。用于 MF 解码器不支持输出缩放时的替代：
  // 解码原生尺寸后在拷贝环节降采样，避免给 SetCurrentMediaType 设非原生尺寸导致
  // 视频轨整条丢失。
  static void downscalePlane(const uint8_t* src, int srcW, int srcH, int srcStride,
                             uint8_t* dst, int dstW, int dstH) {
    if (dstW <= 0 || dstH <= 0 || srcW <= 0 || srcH <= 0) return;
    const double sx = static_cast<double>(srcW) / dstW;
    const double sy = static_cast<double>(srcH) / dstH;
    for (int dy = 0; dy < dstH; dy++) {
      int y0 = static_cast<int>(dy * sy);
      int y1 = static_cast<int>((dy + 1) * sy);
      if (y1 > srcH) y1 = srcH;
      if (y1 <= y0) y1 = y0 + 1;
      for (int dx = 0; dx < dstW; dx++) {
        int x0 = static_cast<int>(dx * sx);
        int x1 = static_cast<int>((dx + 1) * sx);
        if (x1 > srcW) x1 = srcW;
        if (x1 <= x0) x1 = x0 + 1;
        int sum = 0, n = 0;
        for (int yy = y0; yy < y1; yy++) {
          const uint8_t* srow = src + static_cast<size_t>(yy) * srcStride;
          for (int xx = x0; xx < x1; xx++) { sum += srow[xx]; n++; }
        }
        dst[static_cast<size_t>(dy) * dstW + dx] = static_cast<uint8_t>(sum / n);
      }
    }
  }

  // box 平均降采样 NV12 交错色度（U/V 同字节，stride 内每像素占 2 字节）。源色度
  // 逻辑尺寸 srcCW×srcCH（= luma/2），输出 dstCW×dstCH。
  static void downscaleChromaNV12(const uint8_t* uv, int srcCW, int srcCH, int srcStride,
                                  uint8_t* dstU, uint8_t* dstV, int dstCW, int dstCH) {
    if (dstCW <= 0 || dstCH <= 0 || srcCW <= 0 || srcCH <= 0) return;
    const double sx = static_cast<double>(srcCW) / dstCW;
    const double sy = static_cast<double>(srcCH) / dstCH;
    for (int dy = 0; dy < dstCH; dy++) {
      int y0 = static_cast<int>(dy * sy);
      int y1 = static_cast<int>((dy + 1) * sy);
      if (y1 > srcCH) y1 = srcCH;
      if (y1 <= y0) y1 = y0 + 1;
      for (int dx = 0; dx < dstCW; dx++) {
        int x0 = static_cast<int>(dx * sx);
        int x1 = static_cast<int>((dx + 1) * sx);
        if (x1 > srcCW) x1 = srcCW;
        if (x1 <= x0) x1 = x0 + 1;
        int su = 0, sv = 0, n = 0;
        for (int yy = y0; yy < y1; yy++) {
          const uint8_t* srow = uv + static_cast<size_t>(yy) * srcStride;
          for (int xx = x0; xx < x1; xx++) {
            su += srow[2 * xx];
            sv += srow[2 * xx + 1];
            n++;
          }
        }
        dstU[static_cast<size_t>(dy) * dstCW + dx] = static_cast<uint8_t>(su / n);
        dstV[static_cast<size_t>(dy) * dstCW + dx] = static_cast<uint8_t>(sv / n);
      }
    }
  }

  // 2026-08: HDR/杜比源解码器常协商出 P010（10-bit NV12-like）而非 NV12；
  // 也有一些硬件路径输出 NV21（VU 交错）。以下先把这些格式转成中间 NV12，
  // 再复用现有 NV12→I420 路径，避免色度平面错位/互换导致紫绿偏色。
  static void convertP010ToNV12(const uint8_t* p010, int w, int h, int srcStride,
                                uint8_t* nv12, int dstStride) {
    // P010: 10-bit data occupies the upper 10 bits of each 16-bit WORD
    // (low 6 bits zero). To get 8-bit, shift right by 8.
    const uint16_t* srcY = reinterpret_cast<const uint16_t*>(p010);
    const uint16_t* srcUV = reinterpret_cast<const uint16_t*>(p010 + srcStride * h);
    const int srcSamplesPerRow = srcStride / 2;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        nv12[y * dstStride + x] = static_cast<uint8_t>(srcY[y * srcSamplesPerRow + x] >> 8);
      }
    }
    uint8_t* dstUV = nv12 + dstStride * h;
    for (int y = 0; y < h / 2; y++) {
      for (int x = 0; x < w / 2; x++) {
        dstUV[y * dstStride + 2 * x] = static_cast<uint8_t>(srcUV[y * srcSamplesPerRow + 2 * x] >> 8);
        dstUV[y * dstStride + 2 * x + 1] = static_cast<uint8_t>(srcUV[y * srcSamplesPerRow + 2 * x + 1] >> 8);
      }
    }
  }

  static void convertNV21ToNV12(const uint8_t* nv21, int w, int h, int srcStride,
                                uint8_t* nv12, int dstStride) {
    for (int y = 0; y < h; y++) {
      memcpy(nv12 + y * dstStride, nv21 + y * srcStride, w);
    }
    const uint8_t* srcUV = nv21 + srcStride * h;
    uint8_t* dstUV = nv12 + dstStride * h;
    for (int y = 0; y < h / 2; y++) {
      for (int x = 0; x < w / 2; x++) {
        // NV21 是 VU 交错：把 V 放到 U 位置，U 放到 V 位置，即得 NV12
        dstUV[y * dstStride + 2 * x] = srcUV[y * srcStride + 2 * x + 1];
        dstUV[y * dstStride + 2 * x + 1] = srcUV[y * srcStride + 2 * x];
      }
    }
  }

  // 把 GUID 子类型转成可读的静态字符串（仅用于诊断日志）。
  static const char* subTypeName(const GUID& g) {
    if (g == MFVideoFormat_NV12) return "NV12";
    if (g == MFVideoFormat_NV21) return "NV21";
    if (g == MFVideoFormat_P010) return "P010";
    if (g == MFVideoFormat_YV12) return "YV12";
    if (g == MFVideoFormat_I420) return "I420";
    if (g == MFVideoFormat_YUY2) return "YUY2";
    if (g == MFVideoFormat_UYVY) return "UYVY";
    return "unknown";
  }

  void ProcessVideoSample(IMFSample* sample, LONGLONG /*time*/) {
    // 首帧探测硬件解码是否真正生效（让 DXVA/D3D11 回退可被观测）。
    // 硬件 MFT 产生的 sample 会带 MFSampleExtension_Device 属性；软件回退则不带。
    // 整段要么硬件要么软解，首帧定一次即可，经 TSFN 回报实际 hwaccel 状态。
    if (!_hwDetected) {
      _hwDetected = true;
      GUID devGuid = GUID_NULL;
      bool hw = SUCCEEDED(sample->GetGUID(MF_SampleExtension_Device_GUID, &devGuid)) && devGuid != GUID_NULL;
      const char* actual = hw ? "d3d11" : "software";
      _hwAccelActual = actual;
      FrameEvent* ev = new FrameEvent{};
      ev->type = EV_HWACCEL;
      ev->hwaccel = actual;
      if (_tsfn) _tsfn.NonBlockingCall(ev);
    }
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

    // 若解码器实际给出的不是 NV12（HDR/杜比源常见 P010，部分硬件路径给 NV21），
    // 先转成中间 NV12，再复用后续 NV12→I420 逻辑。_trueH 用于色度平面偏移。
    const uint8_t* srcPtr = p0;
    int srcStride = stride;
    std::vector<uint8_t> nv12Temp;
    {
      static int diagLogged = 0;
      if (diagLogged < 5) {
        fprintf(stderr, "[lumen][mf] ProcessVideoSample: subtype=%s stride=%d size=%dx%d trueH=%d locked2d=%d\n",
                subTypeName(_videoSubType), stride, _width, _height, _trueH, locked2d ? 1 : 0);
        diagLogged++;
      }
    }
    if (_videoSubType == MFVideoFormat_P010 || _videoSubType == MFVideoFormat_NV21) {
      const size_t tempSize = static_cast<size_t>(_width) * _trueH
                            + static_cast<size_t>(_width) * (_trueH / 2);
      nv12Temp.resize(tempSize);
      if (_videoSubType == MFVideoFormat_P010) {
        convertP010ToNV12(p0, _width, _trueH, stride, nv12Temp.data(), _width);
      } else {
        convertNV21ToNV12(p0, _width, _trueH, stride, nv12Temp.data(), _width);
      }
      srcPtr = nv12Temp.data();
      srcStride = _width;
    } else if (_videoSubType != GUID_NULL && _videoSubType != MFVideoFormat_NV12) {
      // 未知格式：记日志并跳过该帧（避免以错误格式解读造成花屏/偏色）。
      static int logged = 0;
      if (logged < 5) {
        fprintf(stderr, "[lumen][mf] unsupported video subtype %s, drop frame\n", subTypeName(_videoSubType));
        logged++;
      }
      buf->Unlock(); buf->Release();
      return;
    }

    const int w = _width, h = _height;        // 源（解码原生，逻辑尺寸）
    const int dstW = _outW, dstH = _outH;     // 输出（可能降采样到 maxWidth）
    const bool needScale = (dstW != w) || (dstH != h);
    const int cw = dstW / 2, ch = dstH / 2;
    const size_t ySize = static_cast<size_t>(dstW) * dstH;
    const size_t uvSize = static_cast<size_t>(cw) * ch;
    const size_t total = ySize + 2 * uvSize;

    // 2026-08: electron 禁止 external buffer,池不可用——回退每帧 malloc,
    // TSFN 回调里 Copy 成 Node 内部分配的 Buffer(见 TsfnCallback)。
    uint8_t* out = static_cast<uint8_t*>(malloc(total));
    if (!out) {
      buf->Unlock(); buf->Release();
      return;
    }

    uint8_t* Y = out;
    const uint8_t* uv = srcPtr + static_cast<size_t>(srcStride) * _trueH;
    uint8_t* U = out + ySize;
    uint8_t* V = U + uvSize;

    if (!needScale) {
      // 1:1 路径：Y 平面逐行拷贝（考虑 stride 对齐）
      for (int y = 0; y < h; y++) {
        memcpy(Y + static_cast<size_t>(y) * w, srcPtr + static_cast<size_t>(y) * srcStride, static_cast<size_t>(w));
      }
      // NV12 → I420：解交织 UV（UV 行跨距 = Y 行跨距；色度起始需按「实际解码高度」
      // _trueH 定位，而非承诺高度 _height——MF 常把高度补齐到宏块倍数（如 1080→1088），
      // 否则色度会偏移到错误行、画面下半部出现色彩/错位伪影。
      for (int y = 0; y < h; y++) {
        int cy = y / 2;
        const uint8_t* srow = uv + static_cast<size_t>(cy) * srcStride;
        uint8_t* urow = U + static_cast<size_t>(cy) * cw;
        uint8_t* vrow = V + static_cast<size_t>(cy) * cw;
        for (int x = 0; x < w; x++) {
          int cx = x >> 1;
          urow[cx] = srow[2 * cx];
          vrow[cx] = srow[2 * cx + 1];
        }
      }
    } else {
      // 降采样路径：MF 解码器不支持输出缩放，故在拷贝环节按 maxWidth 做 box 平均
      // 下采样 NV12 → I420。源色度按 _trueH 定位（与 1:1 路径同口径），下采样到
      // dstW×dstH，避免给解码器设非原生尺寸导致视频轨整条丢失（>1920 源静默丢轨）。
      downscalePlane(srcPtr, w, h, srcStride, Y, dstW, dstH);
      downscaleChromaNV12(uv, w / 2, h / 2, srcStride, U, V, cw, ch);
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
      fs.consumed.store(false);  // 槽内有未读帧,解码线程下次写此槽前须等主线程消费
      FrameEvent* ev = new FrameEvent{};
      ev->type = EV_VIDEO;
      ev->pts = pts;
      ev->width = dstW;
      ev->height = dstH;
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

    const int ch = _outChannels;
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

      double pts = _startTime + (static_cast<double>(_audioFrameCount.load()) / 48000.0);
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
    const int ch = _outChannels;
    int avail = static_cast<int>(_audioStaging.size() / ch);
    if (avail <= 0) return;
    size_t nbytes = static_cast<size_t>(avail) * ch * 4;
    float* out = static_cast<float*>(malloc(nbytes));
    if (!out) return;
    memcpy(out, _audioStaging.data(), nbytes);
    _audioStaging.clear();

    double pts = _startTime + (static_cast<double>(_audioFrameCount.load()) / 48000.0);
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
    // 2026-08: 置当前 TSFN ctx 停止标志——残留回调(持旧 ctx)直接丢弃;
    // 旧 ctx 泄漏至残留回调清空(16B,可忽略)
    if (_activeCtx) _activeCtx->stopped.store(true);
    _activeCtx = nullptr;
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
