// contention-addon/src/addon.cpp
//
// Synthetic CPU-heavy native addon used to simulate a native library (e.g.
// TensorFlow, oneDNN, ONNX Runtime) that spins up its own pthread pool and
// keeps it pegged. This addon does not compute anything meaningful -- it
// exists purely to hold CPUs busy in a controlled, externally-observable way
// so a benchmark harness can apply CPU affinity (taskset -p) to Node's own
// threads and to these threads independently, and measure the effect.
//
// Design note -- why threads are spawned at load time but don't start
// burning CPU until start() is called:
//
//   Threads are created once, in Init() (i.e. at `require()` time), and
//   immediately named via pthread_setname_np so they are identifiable from
//   outside the process (e.g. via /proc/<pid>/task/<tid>/comm) before any
//   CPU-heavy work begins. They then block on a condition variable until
//   start() is called from JS, and stop spinning (but stay alive, waiting)
//   when stop() is called.
//
//   This two-phase design -- spawn-and-name-and-wait, then run-on-command --
//   is what lets the benchmark harness enumerate and taskset -p these
//   threads by name during a quiet "readiness" window, before the addon
//   actually begins contending for CPU time. Without it, there would be no
//   window in which the harness could apply affinity before contention
//   already started.

// _GNU_SOURCE (for pthread_setname_np) is defined via binding.gyp's
// "defines" so it's set before any system header is pulled in by whichever
// header napi.h includes first.

#include <napi.h>
#include <pthread.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> g_running{false};
std::atomic<bool> g_shutdown{false};
std::mutex g_mutex;
std::condition_variable g_cv;
std::vector<pthread_t> g_threads;

// Each worker: wait until told to run, then burn CPU with a sustained,
// meaningless floating-point loop (no sleeps, no syscalls, no shared-memory
// traffic between workers) until told to stop. Repeats until shutdown.
void* WorkerMain(void* arg) {
  int index = static_cast<int>(reinterpret_cast<intptr_t>(arg));

  char name[16];
  // "bench-worker-" is 13 chars; glibc allows 15 chars + NUL, so indices
  // 0-99 fit (up to "bench-worker-99" = 15 chars).
  std::snprintf(name, sizeof(name), "bench-worker-%d", index);
  pthread_setname_np(pthread_self(), name);

  for (;;) {
    {
      std::unique_lock<std::mutex> lock(g_mutex);
      g_cv.wait(lock, [] {
        return g_running.load(std::memory_order_relaxed) ||
               g_shutdown.load(std::memory_order_relaxed);
      });
    }
    if (g_shutdown.load(std::memory_order_relaxed)) break;

    // Sustained CPU-bound busy loop. The value is deliberately meaningless;
    // the point is to keep this core's pipeline saturated, not to compute
    // anything. Periodic renormalization avoids floating-point overflow
    // without introducing a branch-predictable syscall or memory stall.
    volatile double x = 1.0000001;
    while (g_running.load(std::memory_order_relaxed) &&
           !g_shutdown.load(std::memory_order_relaxed)) {
      x = x * 1.0000001 + 0.0000001;
      if (x > 1e30 || x < -1e30) x = 1.0000001;
    }
  }
  return nullptr;
}

int ResolveThreadCount() {
  const char* env = std::getenv("ADDON_THREAD_COUNT");
  if (env != nullptr) {
    int n = std::atoi(env);
    if (n > 0) return n;
  }
  unsigned int hc = std::thread::hardware_concurrency();
  return hc > 0 ? static_cast<int>(hc) : 4;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_running.store(true, std::memory_order_relaxed);
  }
  g_cv.notify_all();
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_running.store(false, std::memory_order_relaxed);
  return info.Env().Undefined();
}

Napi::Value ThreadCount(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(g_threads.size()));
}

// napi_cleanup_hook signature: void(*)(void*) -- not the Napi::Env-taking
// convenience overload, so this must be a plain C-style function.
//
// IMPORTANT -- this hook only runs on a *natural* process exit (event loop
// drains with no more work, or process.disconnect() removes the last active
// handle). It does NOT reliably run if JS calls process.exit() directly --
// empirically, on Node 22, process.exit() while this addon is loaded hangs
// forever instead of invoking cleanup hooks and terminating. Every script
// that requires this addon must avoid process.exit() entirely: set
// process.exitCode and let the script return/the event loop drain instead.
// See worker-child.js and test.js for the pattern.
void Cleanup(void* /*arg*/) {
  g_shutdown.store(true, std::memory_order_relaxed);
  g_running.store(false, std::memory_order_relaxed);
  g_cv.notify_all();
  for (pthread_t t : g_threads) {
    pthread_join(t, nullptr);
  }
  g_threads.clear();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  int n = ResolveThreadCount();
  g_threads.reserve(static_cast<size_t>(n));
  for (int i = 0; i < n; i++) {
    pthread_t t;
    int rc = pthread_create(&t, nullptr, WorkerMain,
                             reinterpret_cast<void*>(static_cast<intptr_t>(i)));
    if (rc != 0) {
      Napi::Error::New(env, "contention-addon: pthread_create failed")
          .ThrowAsJavaScriptException();
      break;
    }
    g_threads.push_back(t);
  }

  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("threadCount", Napi::Function::New(env, ThreadCount));

  napi_add_env_cleanup_hook(env, Cleanup, nullptr);

  return exports;
}

}  // namespace

NODE_API_MODULE(contention_addon, Init)
