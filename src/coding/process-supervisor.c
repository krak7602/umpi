/* Public, credential-free process supervision; this is not a security sandbox.
 * Protocol on fd 3: UMPI_SUPERVISOR_V1 {CLEAN exit_code exec_errno stop_reason|BLOCKED reason|UNCERTAIN reason}.
 * CLEAN stop_reason: 0 = main exit, 1 = deadline, 2 = owner cancellation/loss.
 * fd 0 is the owner's lifetime pipe, never command input. EOF/data, SIGTERM,
 * SIGINT, or the absolute deadline starts cleanup. Command stdout/stderr pass
 * through unchanged. Only CLEAN certifies that every owned child was reaped.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void report(const char *kind, const char *reason) {
    dprintf(3, "UMPI_SUPERVISOR_V1 %s %s\n", kind, reason);
}

#if defined(__linux__)
#include <poll.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/syscall.h>

static int pidfd_open_owned(pid_t pid) {
    return (int)syscall(SYS_pidfd_open, pid, 0);
}

static int signal_owned(int descriptor, int signal_number) {
    return (int)syscall(SYS_pidfd_send_signal, descriptor, signal_number, NULL, 0);
}

static int64_t now_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_REALTIME, &now) != 0) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/* This kernel-maintained set contains only this single-threaded helper's direct
 * children, including subreaper adoptions. This is NOT a process-table/liveness
 * poll. None is reaped while the set is read, so an ID cannot be recycled before
 * pidfd_open. Signals use that identity-bound fd, never kill(pid) or kill(-pgid).
 * Killing direct parents causes the kernel to adopt their surviving descendants;
 * the next SIGCHLD wave repeats until waitpid proves ECHILD.
 */
static int visit_children(const char *path, int terminate) {
    int descriptor = open(path, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return -1;
    char buffer[4096];
    unsigned long value = 0;
    int digits = 0, failed = 0;
    for (;;) {
        ssize_t length = read(descriptor, buffer, sizeof(buffer));
        if (length < 0 && errno == EINTR) continue;
        if (length < 0) { failed = 1; break; }
        for (ssize_t index = 0; index <= length; ++index) {
            int end = index == length;
            if (end && length != 0) break;
            unsigned char byte = end ? ' ' : (unsigned char)buffer[index];
            if (byte >= '0' && byte <= '9') {
                value = value * 10 + (byte - '0');
                if (value > INT_MAX) { failed = 1; break; }
                digits = 1;
            } else if (byte == ' ' || byte == '\n' || byte == '\t') {
                if (digits && terminate) {
                    int owned = pidfd_open_owned((pid_t)value);
                    if (owned < 0) failed = 1;
                    else {
                        if (signal_owned(owned, SIGKILL) != 0 && errno != ESRCH) failed = 1;
                        close(owned);
                    }
                }
                value = 0;
                digits = 0;
            } else { failed = 1; break; }
        }
        if (failed || length == 0) break;
    }
    close(descriptor);
    return failed ? -1 : 0;
}

static int main_code(int status) {
    return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_DFL);
    if (argc < 5 || strcmp(argv[1], "--deadline-at-ms") != 0 || strcmp(argv[3], "--") != 0) {
        report("BLOCKED", "invalid_supervisor_arguments");
        return 125;
    }
    char *end;
    errno = 0;
    int64_t deadline = strtoll(argv[2], &end, 10);
    if (errno || *end || deadline <= 0 || now_ms() < 0 || now_ms() >= deadline) {
        report("BLOCKED", "expired_or_invalid_deadline");
        return 125;
    }
    if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0 || prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
        report("BLOCKED", "child_subreaper_unavailable");
        return 125;
    }
    int probe = pidfd_open_owned(getpid());
    if (probe < 0 || signal_owned(probe, 0) != 0) {
        if (probe >= 0) close(probe);
        report("BLOCKED", "identity_safe_child_signals_unavailable");
        return 125;
    }
    close(probe);
    char children_path[128];
    snprintf(children_path, sizeof(children_path), "/proc/self/task/%ld/children", (long)getpid());
    if (visit_children(children_path, 0) != 0) {
        report("BLOCKED", "kernel_child_ownership_unavailable");
        return 125;
    }
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    sigaddset(&mask, SIGTERM);
    sigaddset(&mask, SIGINT);
    if (sigprocmask(SIG_BLOCK, &mask, NULL) != 0) {
        report("BLOCKED", "supervision_signal_setup_failed");
        return 125;
    }
    int signals = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
    int gate[2], execution_error[2];
    if (signals < 0 || pipe2(gate, O_CLOEXEC) != 0) {
        report("BLOCKED", "supervision_event_setup_failed");
        return 125;
    }
    if (pipe2(execution_error, O_CLOEXEC | O_NONBLOCK) != 0) {
        report("BLOCKED", "supervision_exec_setup_failed");
        return 125;
    }
    pid_t command = fork();
    if (command < 0) {
        report("BLOCKED", "command_fork_failed");
        return 125;
    }
    if (command == 0) {
        close(gate[1]);
        close(execution_error[0]);
        close(signals);
        close(3);
        char permission;
        ssize_t received;
        do { received = read(gate[0], &permission, 1); } while (received < 0 && errno == EINTR);
        close(gate[0]);
        if (received != 1) _exit(125);
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        signal(SIGPIPE, SIG_DFL);
        /* A private initial process group preserves native command conventions;
         * detached descendants remain owned by the subreaper, not by this group.
         */
        setpgid(0, 0);
        close(0);
        int input = open("/dev/null", O_RDONLY);
        if (input != 0 && input >= 0) { dup2(input, 0); close(input); }
        execvp(argv[4], &argv[4]);
        int error = errno;
        (void)write(execution_error[1], &error, sizeof(error));
        _exit(127);
    }
    close(gate[0]);
    close(execution_error[1]);
    int cleaning = 0, main_status = 0, main_exited = 0, uncertain = 0, stopped_reason = 0;
    struct pollfd events[2] = { { .fd = 0, .events = POLLIN | POLLHUP }, { .fd = signals, .events = POLLIN } };
    /* Check owner/deadline before allowing any command effect. */
    int pending = poll(events, 2, 0);
    if (pending < 0 || events[0].revents) { cleaning = 1; stopped_reason = 2; }
    else if (now_ms() >= deadline) { cleaning = 1; stopped_reason = 1; }
    if (events[1].revents & POLLIN) {
        struct signalfd_siginfo event;
        while (read(signals, &event, sizeof(event)) == sizeof(event)) {
            if (event.ssi_signo != SIGCHLD) { cleaning = 1; stopped_reason = 2; }
        }
    }
    if (!cleaning) {
        char permission = '1';
        if (write(gate[1], &permission, 1) != 1) { cleaning = 1; stopped_reason = 2; }
    }
    close(gate[1]);
    for (;;) {
        int no_children = 0;
        for (;;) {
            int status;
            pid_t child = waitpid(-1, &status, WNOHANG);
            if (child > 0) {
                if (child == command) { main_status = status; main_exited = 1; cleaning = 1; }
                continue;
            }
            if (child < 0 && errno == EINTR) continue;
            if (child < 0 && errno == ECHILD) no_children = 1;
            else if (child < 0) {
                cleaning = 1;
                if (!uncertain) report("UNCERTAIN", "child_reaping_failed");
                uncertain = 1;
            }
            break;
        }
        if (no_children) {
            if (!main_exited || uncertain) {
                if (!uncertain) report("UNCERTAIN", "main_exit_status_unavailable");
                return 125;
            }
            int error = 0;
            (void)read(execution_error[0], &error, sizeof(error));
            dprintf(3, "UMPI_SUPERVISOR_V1 CLEAN %d %d %d\n", main_code(main_status), error, stopped_reason);
            return 0;
        }
        int64_t current = now_ms();
        int64_t remaining = current < 0 ? 0 : deadline - current;
        if (current < 0) {
            if (!uncertain) report("UNCERTAIN", "deadline_clock_unavailable");
            uncertain = 1;
            cleaning = 1;
        }
        if (remaining <= 0 && !cleaning) { cleaning = 1; stopped_reason = 1; }
        if (cleaning && visit_children(children_path, 1) != 0) {
            if (!uncertain) report("UNCERTAIN", "owned_child_cleanup_unavailable");
            uncertain = 1;
        }
        /* No timed PID/liveness sampling: child adoption/reaping wakes signalfd.
         * During cleanup the helper stays alive, even for an unkillable child.
         */
        int timeout = cleaning ? -1 : remaining > INT_MAX ? INT_MAX : (int)remaining;
        int count = poll(events, 2, timeout);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) {
            if (!uncertain) report("UNCERTAIN", "supervision_event_wait_failed");
            uncertain = 1;
            cleaning = 1;
            continue;
        }
        if (events[0].revents) {
            if (!cleaning) stopped_reason = 2;
            cleaning = 1;
            events[0].fd = -1;
        }
        if (events[1].revents & POLLIN) {
            struct signalfd_siginfo event;
            while (read(signals, &event, sizeof(event)) == sizeof(event)) {
                if (event.ssi_signo != SIGCHLD) {
                    if (!cleaning) stopped_reason = 2;
                    cleaning = 1;
                }
            }
        }
    }
}
#else
#error "The native descendant supervisor is Linux-only; Mac uses its explicit foreground-group launcher"
#endif
