/**
 * Which file system a directory is on (Linux: /proc/mounts). SQLite in WAL mode needs shared memory
 * and working locks on the same host – a database on NFS/SMB is the realistic corruption risk.
 */
import fs from 'node:fs';
import path from 'node:path';

const NETWORK_FS = /^(nfs4?|cifs|smb3?|smbfs|fuse\.sshfs|sshfs|9p|afs|ceph|glusterfs|fuse\.rclone|davfs|fuse\.s3fs)$/i;

export interface MountInfo {
  mountPoint: string;
  fsType: string;
  network: boolean;
}

/** The mount a path lives on (longest matching mount point), or null when unknown. */
export function mountOf(dir: string): MountInfo | null {
  let mounts: string;
  try {
    mounts = fs.readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null;
  }
  let target: string;
  try {
    target = fs.realpathSync(dir);
  } catch {
    target = path.resolve(dir);
  }
  let best: MountInfo | null = null;
  for (const line of mounts.split('\n')) {
    const [, mountPoint, fsType] = line.split(' ');
    if (!mountPoint || !fsType) continue;
    const mp = mountPoint.replace(/\\040/g, ' ');
    if ((target === mp || target.startsWith(mp.endsWith('/') ? mp : `${mp}/`)) && (!best || mp.length > best.mountPoint.length)) {
      best = { mountPoint: mp, fsType, network: NETWORK_FS.test(fsType) };
    }
  }
  return best;
}

/** A warning when the database directory is on a network file system. */
export function networkFsWarning(dataDir: string): string | null {
  const m = mountOf(dataDir);
  if (!m?.network) return null;
  return `The data directory is on a network file system (${m.fsType} at ${m.mountPoint}). The SQLite database can be damaged there – keep data/ on a local disk (the file store may stay on the network share).`;
}
