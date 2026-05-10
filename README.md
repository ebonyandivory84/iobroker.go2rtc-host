# iobroker.go2rtc-host

ioBroker Adapter, der einen **stand-alone go2rtc Prozess** ohne Docker startet und steuert.

## Features

- Start/Stop/Restart von go2rtc
- Optionaler Binary-Download aus GitHub Releases
- Status-States (`running`, `mode`, `message`, `pid`, letzte Log-/Error-Zeile)
- Autostart bei Adapter-Start

## Wichtige Pfade

In der Admin-Konfiguration setzen:

- `binaryPath`: z. B. `/opt/iobroker/go2rtc/go2rtc`
- `configPath`: z. B. `/opt/iobroker/go2rtc/go2rtc.yaml`
- `workingDir`: z. B. `/opt/iobroker/go2rtc`

## States

- `go2rtc-host.0.control.start` (write `true`)
- `go2rtc-host.0.control.stop` (write `true`)
- `go2rtc-host.0.control.restart` (write `true`)
- `go2rtc-host.0.control.install` (write `true`)
- `go2rtc-host.0.status.*`

## Beispiel go2rtc.yaml

```yaml
streams:
  instar9820:
    - rtsp://admin:PASSWORT@192.168.1.50:554/livestream/11
```

Für Browser-WebRTC (inkl. Mic) z. B.:

- `http://<host>:1984/stream.html?src=instar9820&mode=webrtc&media=video,audio,microphone`

## Hinweis

Für Mikrofon im Browser ist in der Praxis meist HTTPS nötig (oder lokales trusted setup).
