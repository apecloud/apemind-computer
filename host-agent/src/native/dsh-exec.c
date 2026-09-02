#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  int i = 1;
  if (i < argc && strcmp(argv[i], "--") == 0) {
    i++;
  }
  if (i >= argc) {
    fprintf(stderr, "usage: dsh-exec -- cmd [args...]\n");
    return 127;
  }
  (void)prctl(PR_SET_PDEATHSIG, SIGKILL);
  if (getppid() == 1) {
    _exit(128);
  }
  (void)setpgid(0, 0);
  execvp(argv[i], argv + i);
  perror("dsh-exec");
  return 127;
}
