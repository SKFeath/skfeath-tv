# Deploying the Homies room server (Oracle / any Ubuntu VM)

This is the fan-out server that powers the **Room** tab — one NVision
connection shared to all your friends. Do this while your NVision order
activates; the only step that needs the live sub is filling in `.env`.

## Step 1 — Create the VM (Oracle Always Free)

1. In the Oracle Cloud console: **Compute → Instances → Create Instance**.
2. **Image:** Canonical **Ubuntu** (22.04 or 24.04).
3. **Shape:** try **Ampere (Arm) VM.Standard.A1.Flex** (1 OCPU / 6 GB is plenty).
   If it says *"out of capacity"*, switch to **VM.Standard.E2.1.Micro** (AMD) —
   it's weaker but fine for this (the server just copies one video stream).
4. **SSH keys:** let it generate a key pair and **download the private key** —
   you'll need it to log in.
5. Create. Note the instance's **public IP**.

## Step 2 — Open the firewall (people always miss the second one)

Oracle blocks everything by default. Open ports **80** and **443** in **both** places:

- **Oracle side:** Networking → your VCN → the subnet's **Security List** → add
  Ingress Rules: source `0.0.0.0/0`, TCP ports `80` and `443`.
- **Ubuntu side (SSH in first, see step 3):**
  ```bash
  sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save   # if the command is missing: sudo apt-get install -y iptables-persistent
  ```

## Step 3 — Log in and run setup

```bash
ssh -i /path/to/your-key.key ubuntu@YOUR_PUBLIC_IP
```
Then:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/SKFeath/skfeath-tv/main/deploy/setup.sh)
```
It installs Node + the code and stops so you can fill in `.env`.

## Step 4 — Fill in .env (needs your active NVision sub)

```bash
cd ~/skfeath-tv
nano .env
```
Set:
- `XTREAM_BASE`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` — from your NVision M3U
  (or `M3U_URL=` the full get.php link). **Keep it http:// if they say so.**
- `UPSTREAM_CONNECTIONS=1`
- `ACCESS_CODES=you:yourcode:1,friend:code:2,...` — ranks for the Boss system.
- `SESSION_SECRET=` a long random string.
- `COOKIE_SECURE=1` (you'll be on HTTPS).

Then re-run:
```bash
bash deploy/setup.sh
```
This installs the auto-start service. Check it: `systemctl status skfeath-tv`.

## Step 5 — HTTPS with a Cloudflare Tunnel (no domain, no open ports)

The tunnel dials OUT from the VM to Cloudflare, so you don't even need the
firewall ports from step 2 for this. Two flavours:

### Quick tunnel (instant, throwaway URL — good for a first test)
```bash
curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
# on the AMD Micro shape use ...cloudflared-linux-amd64 instead
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
cloudflared tunnel --url http://localhost:3000
```
It prints a `https://something-random.trycloudflare.com` URL. That's your
room, over HTTPS, immediately. (This URL changes each run — fine for testing,
not for the real thing.)

### Named tunnel (stable URL that survives reboots — for the real room)
```bash
cloudflared tunnel login          # opens a link; approve in your Cloudflare account
cloudflared tunnel create homies
# map it to a hostname on a domain in your Cloudflare account:
cloudflared tunnel route dns homies room.yourdomain.com
sudo cloudflared service install   # runs it on boot
```
Config lives in `~/.cloudflared/config.yml`:
```yaml
tunnel: homies
credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: room.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```
Your room is then permanently at `https://room.yourdomain.com`.

> A named tunnel needs a domain in your Cloudflare account. If you don't have
> one, start with the quick tunnel to test, and grab a cheap domain (or a free
> one) when you want the permanent link. Tell me which and I'll help.

Either way, set `COOKIE_SECURE=1` in `.env` since you're now on HTTPS.

## Step 6 — Tell me the URL

Send me the room's `https://…` address. I set `ROOM_URL` to it, rebuild the
site, and the **Room** tab lights up with your live NVision channels + the
ranked Boss controls. Done.

---

### Handy commands
```bash
systemctl status skfeath-tv        # is it running?
journalctl -u skfeath-tv -f        # live logs
cd ~/skfeath-tv && git pull && sudo systemctl restart skfeath-tv   # update
npm run check                      # test your NVision credentials + HLS
```
