# Deploying AcmePay

> ⚠️ Demo target app with intentional vulnerabilities. Deploy only to an
> isolated demo environment (e.g. a throwaway Linode VM). Never expose it to the
> public internet with real data.

## Option A — Plain Node (`npm start`)

Requirements: Node.js ≥ 18 and a C/C++ toolchain (`better-sqlite3` compiles a
native addon). On Debian/Ubuntu: `apt-get install -y build-essential python3`.

```bash
cd target-app
npm install
npm run seed
PORT=8070 npm start
```

The server binds `0.0.0.0:8070`. Browse to `http://<host>:8070/`.

To run it under a process manager (survives reboot / crashes):

```bash
npm install -g pm2
pm2 start src/server.js --name acmepay
pm2 save
```

## Option B — Docker

```bash
cd target-app
docker build -t acmepay .
docker run -d --name acmepay -p 8070:8070 acmepay
```

- The image installs build tools, `npm install --omit=dev`, and seeds the DB.
- Override the port with `-e PORT=9000 -p 9000:9000`.
- Persist the DB across container restarts with a volume:
  `-v acmepay-data:/app/data`.

Check it:

```bash
curl http://localhost:8070/health
```

## Deploying to a Linode VM (demo)

1. Create a small Linode (Nanode 1GB is enough), Ubuntu 22.04+.
2. SSH in, install Docker (`curl -fsSL https://get.docker.com | sh`).
3. Copy this `target-app/` directory to the VM (`scp -r target-app root@<ip>:~/`).
4. `cd target-app && docker build -t acmepay . && docker run -d -p 8070:8070 --name acmepay acmepay`
5. Open the Linode firewall for TCP 8070 (demo only).
6. Point Ari's monitor at `http://<linode-ip>:8070`.

## Stopping

```bash
# plain node:  Ctrl-C, or kill the process / pm2 stop acmepay
# docker:      docker stop acmepay && docker rm acmepay
```
