// Non-blocking SSH helpers built on the system `ssh` binary with ControlMaster
// multiplexing (one TCP connection per node, reused by every sample/command).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = path.join(os.homedir(), '.ssh', 'id_ed25519');
const STATE_DIR = new URL('../../.fleet/', import.meta.url).pathname;
fs.mkdirSync(STATE_DIR, { recursive: true });
const KNOWN_HOSTS = path.join(STATE_DIR, 'known_hosts');

export const PUBKEY_PATH = `${KEY}.pub`;

function sshArgs(ip, connectTimeout = 6) {
  return [
    '-i', KEY,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=/tmp/arinet-%C',
    '-o', 'ControlPersist=120',
    '-o', 'ServerAliveInterval=10',
    '-o', 'LogLevel=ERROR',
    `root@${ip}`,
  ];
}

// Run a remote command; `input` (string/Buffer) is piped to its stdin.
// Resolves { code, stdout, stderr }; never rejects except on spawn failure.
export function sshRun(ip, command, { input = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...sshArgs(ip), command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); };
    const timer = setTimeout(() => { stderr += '\n[timeout]'; child.kill('SIGKILL'); finish(124); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 4e6) stdout = stdout.slice(-2e6); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e5) stderr = stderr.slice(-1e5); });
    child.on('error', (e) => { stderr += e.message; finish(127); });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

// Stream a locally produced tarball (from `tar` args) into a remote command.
export function sshPipeTar(ip, tarArgs, remoteCmd, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    const tar = spawn('tar', tarArgs, { cwd, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const ssh = spawn('ssh', [...sshArgs(ip), remoteCmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stderr }); };
    const timer = setTimeout(() => { tar.kill('SIGKILL'); ssh.kill('SIGKILL'); finish(124); }, timeoutMs);
    tar.stdout.pipe(ssh.stdin);
    tar.stderr.on('data', (d) => { stderr += d; });
    ssh.stderr.on('data', (d) => { stderr += d; });
    ssh.stdout.resume();
    tar.on('error', (e) => { stderr += e.message; finish(127); });
    ssh.on('error', (e) => { stderr += e.message; finish(127); });
    ssh.on('close', (code) => finish(code ?? 1));
  });
}

export function forgetHost(ip) {
  return new Promise((resolve) => {
    execFile('ssh-keygen', ['-R', ip, '-f', KNOWN_HOSTS], () => {
      try { fs.rmSync(`${KNOWN_HOSTS}.old`, { force: true }); } catch { /* ignore */ }
      resolve();
    });
  });
}

export function closeMaster(ip) {
  return new Promise((resolve) => {
    execFile('ssh', ['-O', 'exit', ...sshArgs(ip)], { timeout: 5000 }, () => resolve());
  });
}
