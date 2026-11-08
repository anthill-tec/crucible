/*
 * A small native host test harness that keeps the arduino client's make
 * contract, for the client's end-to-end tests. It is a test fixture: Crucible
 * ships no native harness, and a project's own harness is its own.
 *
 * Per test, in order:
 *   - when NATIVE_TEST_MARK_DIR is set, it touches `<suite>.<name>.started`;
 *   - it waits NATIVE_TEST_DELAY_MS milliseconds (0 when unset), then runs
 *     the test body;
 *   - it prints `  ok   <name>`, `  FAIL <name>: <message>` or
 *     `  IGNORE <name>: <message>` on stdout (no Unity verdict line);
 *   - when CRUCIBLE_STREAM is set, it appends ONE `crucible-events`
 *     `test-end` line to that file, in one write, and flushes it;
 *   - when NATIVE_TEST_MARK_DIR is set, it touches `<suite>.<name>.ended`.
 *
 * After its last test it writes `$REPORTS_DIR/TEST-<suite>.xml` (REPORTS_DIR
 * defaults to `reports`). With NATIVE_JUNIT_DROP_LAST set to the suite's
 * name, that report leaves the suite's last test out. It never writes a
 * `run-start` or a `run-end`. It exits 1 when a test failed, else 0.
 *
 * NT_CRASH_MID_LINE() writes the first half of a `test-end` line to the
 * stream, flushes it, and raises SIGSEGV: a binary that dies mid-write.
 */
#pragma once

#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <thread>
#include <vector>

struct NtCase {
  const char *name;
  std::function<void()> fn;
};

struct NtOutcome {
  std::string name;
  std::string status;  // pass | fail | pending
  std::string message;
  long duration_ms;
};

inline std::vector<NtCase> &nt_cases() {
  static std::vector<NtCase> cases;
  return cases;
}

inline std::string &nt_status() {
  static std::string status;
  return status;
}

inline std::string &nt_message() {
  static std::string message;
  return message;
}

inline const char *&nt_suite() {
  static const char *suite = "native";
  return suite;
}

inline FILE *&nt_stream() {
  static FILE *stream = nullptr;
  return stream;
}

inline bool nt_add(const char *name, void (*fn)()) {
  nt_cases().push_back(NtCase{name, fn});
  return true;
}

#define NT_TEST(name)                                        \
  static void name();                                        \
  static const bool nt_registered_##name = nt_add(#name, name); \
  static void name()

#define NT_CHECK(cond, msg)                                  \
  do {                                                       \
    if (!(cond) && nt_status() == "pass") {                  \
      nt_status() = "fail";                                  \
      nt_message() = (msg);                                  \
    }                                                        \
  } while (0)

#define NT_IGNORE(msg)                                       \
  do {                                                       \
    nt_status() = "pending";                                 \
    nt_message() = (msg);                                    \
    return;                                                  \
  } while (0)

inline std::string nt_json(const std::string &text) {
  std::string out = "\"";
  for (char c : text) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else {
      out += c;
    }
  }
  return out + "\"";
}

inline std::string nt_xml(const std::string &text) {
  std::string out;
  for (char c : text) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += c;
    }
  }
  return out;
}

inline void nt_touch(const char *name, const char *phase) {
  const char *dir = std::getenv("NATIVE_TEST_MARK_DIR");
  if (dir == nullptr || *dir == '\0') return;
  std::string path = std::string(dir) + "/" + nt_suite() + "." + name + "." + phase;
  FILE *mark = std::fopen(path.c_str(), "w");
  if (mark != nullptr) std::fclose(mark);
}

inline std::string nt_test_end(const NtOutcome &outcome) {
  std::string line = "{\"event\":\"test-end\",\"suite\":" + nt_json(nt_suite()) +
                     ",\"name\":" + nt_json(outcome.name) +
                     ",\"status\":" + nt_json(outcome.status) +
                     ",\"duration_ms\":" + std::to_string(outcome.duration_ms);
  if (outcome.status == "fail") {
    line += ",\"failure\":{\"message\":" + nt_json(outcome.message) + "}";
  }
  return line + "}\n";
}

inline void nt_append(const std::string &text) {
  FILE *stream = nt_stream();
  if (stream == nullptr) return;
  std::fwrite(text.data(), 1, text.size(), stream);
  std::fflush(stream);
}

#define NT_CRASH_MID_LINE()                                                    \
  do {                                                                         \
    NtOutcome cut{"cut_short", "pass", "", 0};                                 \
    std::string line = nt_test_end(cut);                                       \
    nt_append(line.substr(0, line.size() / 2));                                \
    std::raise(SIGSEGV);                                                       \
  } while (0)

inline void nt_write_junit(const std::vector<NtOutcome> &outcomes) {
  const char *dir = std::getenv("REPORTS_DIR");
  std::string path = std::string(dir != nullptr && *dir != '\0' ? dir : "reports") +
                     "/TEST-" + nt_suite() + ".xml";
  const char *drop = std::getenv("NATIVE_JUNIT_DROP_LAST");
  size_t count = outcomes.size();
  if (drop != nullptr && std::strcmp(drop, nt_suite()) == 0 && count > 0) count -= 1;
  int failures = 0, skipped = 0;
  for (size_t i = 0; i < count; ++i) {
    if (outcomes[i].status == "fail") ++failures;
    if (outcomes[i].status == "pending") ++skipped;
  }
  FILE *report = std::fopen(path.c_str(), "w");
  if (report == nullptr) {
    std::printf("could not write %s\n", path.c_str());
    return;
  }
  std::fprintf(report, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites>\n");
  std::fprintf(report,
               "  <testsuite name=\"%s\" tests=\"%zu\" failures=\"%d\" skipped=\"%d\" errors=\"0\">\n",
               nt_suite(), count, failures, skipped);
  for (size_t i = 0; i < count; ++i) {
    const NtOutcome &o = outcomes[i];
    std::fprintf(report, "    <testcase name=\"%s\" classname=\"%s\" time=\"%.3f\"",
                 nt_xml(o.name).c_str(), nt_suite(), o.duration_ms / 1000.0);
    if (o.status == "pass") {
      std::fprintf(report, "/>\n");
    } else if (o.status == "fail") {
      std::fprintf(report, ">\n      <failure message=\"%s\">%s</failure>\n    </testcase>\n",
                   nt_xml(o.message).c_str(), nt_xml(o.message).c_str());
    } else {
      std::fprintf(report, ">\n      <skipped message=\"%s\"/>\n    </testcase>\n",
                   nt_xml(o.message).c_str());
    }
  }
  std::fprintf(report, "  </testsuite>\n</testsuites>\n");
  std::fclose(report);
}

inline int nt_run(const char *suite) {
  nt_suite() = suite;
  const char *stream_path = std::getenv("CRUCIBLE_STREAM");
  if (stream_path != nullptr && *stream_path != '\0') nt_stream() = std::fopen(stream_path, "a");
  const char *delay_text = std::getenv("NATIVE_TEST_DELAY_MS");
  long delay = delay_text != nullptr ? std::atol(delay_text) : 0;
  std::vector<NtOutcome> outcomes;
  int failed = 0;
  for (const NtCase &test : nt_cases()) {
    nt_touch(test.name, "started");
    auto began = std::chrono::steady_clock::now();
    if (delay > 0) std::this_thread::sleep_for(std::chrono::milliseconds(delay));
    nt_status() = "pass";
    nt_message().clear();
    test.fn();
    long took = (long)std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - began).count();
    NtOutcome outcome{test.name, nt_status(), nt_message(), took};
    if (outcome.status == "pass") {
      std::printf("  ok   %s\n", test.name);
    } else if (outcome.status == "fail") {
      ++failed;
      std::printf("  FAIL %s: %s\n", test.name, outcome.message.c_str());
    } else {
      std::printf("  IGNORE %s: %s\n", test.name, outcome.message.c_str());
    }
    std::fflush(stdout);
    nt_append(nt_test_end(outcome));
    nt_touch(test.name, "ended");
    outcomes.push_back(outcome);
  }
  if (nt_stream() != nullptr) std::fclose(nt_stream());
  nt_write_junit(outcomes);
  return failed > 0 ? 1 : 0;
}
