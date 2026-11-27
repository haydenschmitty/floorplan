import fs from 'node:fs';

/** Read at most limit bytes, and only from a regular file. Never wait for a pipe or read to an unbounded EOF. */
export function readRegularFile(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return null;
    const data = Buffer.alloc(limit + 1);
    const length = fs.readSync(fd, data, 0, data.length, 0);
    return length <= limit ? data.subarray(0, length) : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
