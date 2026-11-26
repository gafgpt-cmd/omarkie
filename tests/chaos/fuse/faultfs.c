// faultfs: a passthrough FUSE3 filesystem that can fail the way real drives do.
// Unprivileged test helper for G23. Modes: passthrough, enospc (byte budget), eio (second write fails),
// rename-eio (every rename fails), plus a per-operation delay. Bind one read-only source tree.
#define FUSE_USE_VERSION 35
#include <fuse3/fuse.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

static char source[4096];
static long budget = -1, used = 0, delay_ms = 0;
static int mode = 0; // 0 passthrough, 1 enospc, 2 eio, 3 rename-eio
static int writes = 0;

static void fault_delay(void) {
  if (delay_ms > 0) usleep((useconds_t)delay_ms * 1000);
}

static int path_of(const char *path, char out[8192]) {
  int n = snprintf(out, 8192, "%s%s", source, path);
  return n > 0 && n < 8192 ? 0 : -ENAMETOOLONG;
}

static int ff_getattr(const char *path, struct stat *st, struct fuse_file_info *fi) {
  (void)fi;
  char full[8192];
  fault_delay();
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (lstat(full, st)) return -errno;
  return 0;
}

static int ff_readlink(const char *path, char *target, size_t size) {
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  ssize_t n = readlink(full, target, size - 1);
  if (n < 0) return -errno;
  target[n] = 0;
  return 0;
}

static int ff_mkdir(const char *path, mode_t mode_) {
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (mkdir(full, mode_)) return -errno;
  return 0;
}

static int ff_rmdir(const char *path) {
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (rmdir(full)) return -errno;
  return 0;
}

static int ff_unlink(const char *path) {
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (unlink(full)) return -errno;
  return 0;
}

static int ff_rename(const char *from, const char *to, unsigned int flags) {
  // rename-eio targets the user's page only, so the store's own atomic writes still set up.
  if (mode == 3 && !strstr(to, "/.omarkie/") && strlen(to) > 3 && !strcmp(to + strlen(to) - 3, ".md")) return -EIO;
  char a[8192], b[8192];
  if (path_of(from, a) || path_of(to, b)) return -ENAMETOOLONG;
  if (flags) return -EINVAL;
  if (rename(a, b)) return -errno;
  return 0;
}

static int ff_chmod(const char *path, mode_t mode_, struct fuse_file_info *fi) {
  (void)fi;
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (chmod(full, mode_)) return -errno;
  return 0;
}

static int ff_truncate(const char *path, off_t size, struct fuse_file_info *fi) {
  (void)fi;
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (truncate(full, size)) return -errno;
  return 0;
}

static int ff_open(const char *path, struct fuse_file_info *fi) {
  char full[8192];
  fault_delay();
  if (path_of(path, full)) return -ENAMETOOLONG;
  int fd = open(full, fi->flags);
  if (fd < 0) return -errno;
  fi->fh = (uint64_t)fd;
  return 0;
}

static int ff_create(const char *path, mode_t mode_, struct fuse_file_info *fi) {
  char full[8192];
  fault_delay();
  if (path_of(path, full)) return -ENAMETOOLONG;
  int fd = open(full, fi->flags | O_CREAT, mode_);
  if (fd < 0) return -errno;
  fi->fh = (uint64_t)fd;
  return 0;
}

static int ff_read(const char *path, char *buffer, size_t size, off_t offset, struct fuse_file_info *fi) {
  (void)path;
  fault_delay();
  ssize_t n = pread((int)fi->fh, buffer, size, offset);
  return n < 0 ? -errno : (int)n;
}

static int ff_write(const char *path, const char *buffer, size_t size, off_t offset, struct fuse_file_info *fi) {
  (void)path;
  fault_delay();
  writes += 1;
  if (mode == 2 && writes >= 2) return -EIO;
  if (mode == 1) {
    long left = budget - used;
    if (left <= 0) return -ENOSPC;
    if ((long)size > left) {
      ssize_t n = pwrite((int)fi->fh, buffer, (size_t)left, offset);
      if (n < 0) return -errno;
      used += n;
      return (int)n; // a short write with no error, exactly what a full disk returns
    }
  }
  ssize_t n = pwrite((int)fi->fh, buffer, size, offset);
  if (n < 0) return -errno;
  if (mode == 1) used += n;
  return (int)n;
}

static int ff_fsync(const char *path, int data, struct fuse_file_info *fi) {
  (void)path; (void)data;
  if (fsync((int)fi->fh)) return -errno;
  return 0;
}

static int ff_release(const char *path, struct fuse_file_info *fi) {
  (void)path;
  close((int)fi->fh);
  return 0;
}

static int ff_readdir(const char *path, void *buffer, fuse_fill_dir_t filler, off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
  (void)offset; (void)fi; (void)flags;
  char full[8192];
  fault_delay();
  if (path_of(path, full)) return -ENAMETOOLONG;
  DIR *dir = opendir(full);
  if (!dir) return -errno;
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    struct stat st;
    memset(&st, 0, sizeof st);
    st.st_ino = entry->d_ino;
    st.st_mode = entry->d_type << 12;
    if (filler(buffer, entry->d_name, &st, 0, 0)) break;
  }
  closedir(dir);
  return 0;
}

static int ff_utimens(const char *path, const struct timespec times[2], struct fuse_file_info *fi) {
  (void)fi;
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (utimensat(AT_FDCWD, full, times, AT_SYMLINK_NOFOLLOW)) return -errno;
  return 0;
}

static int ff_statfs(const char *path, struct statvfs *st) {
  char full[8192];
  (void)path;
  if (path_of("", full)) return -ENAMETOOLONG;
  if (statvfs(full, st)) return -errno;
  if (mode == 1) st->f_bsize = 4096;
  return 0;
}

static int ff_access(const char *path, int mask) {
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (access(full, mask)) return -errno;
  return 0;
}

static int ff_symlink(const char *target, const char *path) {
  char full[8192];
  if (path_of(path, full)) return -ENAMETOOLONG;
  if (symlink(target, full)) return -errno;
  return 0;
}

static int ff_link(const char *from, const char *to) {
  char a[8192], b[8192];
  if (path_of(from, a) || path_of(to, b)) return -ENAMETOOLONG;
  if (link(a, b)) return -errno;
  return 0;
}

static struct fuse_operations ops = {
  .getattr = ff_getattr,
  .readlink = ff_readlink,
  .mkdir = ff_mkdir,
  .rmdir = ff_rmdir,
  .unlink = ff_unlink,
  .rename = ff_rename,
  .chmod = ff_chmod,
  .truncate = ff_truncate,
  .open = ff_open,
  .create = ff_create,
  .read = ff_read,
  .write = ff_write,
  .fsync = ff_fsync,
  .release = ff_release,
  .readdir = ff_readdir,
  .utimens = ff_utimens,
  .statfs = ff_statfs,
  .access = ff_access,
  .symlink = ff_symlink,
  .link = ff_link,
};

int main(int argc, char *argv[]) {
  if (argc < 3) {
    fprintf(stderr, "usage: faultfs <source> <mountpoint> [fuse options]\n");
    return 2;
  }
  if (!realpath(argv[1], source)) { perror("faultfs source"); return 2; }
  const char *env_mode = getenv("FAULTFS_MODE");
  if (env_mode && !strcmp(env_mode, "enospc")) mode = 1;
  else if (env_mode && !strcmp(env_mode, "eio")) mode = 2;
  else if (env_mode && !strcmp(env_mode, "rename-eio")) mode = 3;
  if (getenv("FAULTFS_BUDGET")) budget = atol(getenv("FAULTFS_BUDGET"));
  if (getenv("FAULTFS_DELAY_MS")) delay_ms = atol(getenv("FAULTFS_DELAY_MS"));
  char *fuse_argv[16];
  int n = 0;
  fuse_argv[n++] = argv[0];
  fuse_argv[n++] = argv[2];
  fuse_argv[n++] = "-s";
  fuse_argv[n++] = "-o";
  fuse_argv[n++] = "fsname=faultfs,default_permissions";
  for (int index = 3; index < argc && n < 14; index += 1) fuse_argv[n++] = argv[index];
  fuse_argv[n] = NULL;
  return fuse_main(n, fuse_argv, &ops, NULL);
}
