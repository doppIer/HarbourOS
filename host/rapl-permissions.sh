#!/usr/bin/env bash
# Run ON THE HOST:  sudo bash host/rapl-permissions.sh
# Since kernel 5.10 (CVE-2020-8694) RAPL energy counters are root-only. This
# makes the package counter world-readable at every boot so HarborOS can
# estimate power without running as root. (Coarse energy readings only.)
set -euo pipefail
cat > /etc/systemd/system/rapl-read.service <<'EOF'
[Unit]
Description=Make Intel RAPL energy counter readable for HarborOS

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'chmod o+r /sys/class/powercap/intel-rapl:0/energy_uj'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now rapl-read.service
cat /sys/class/powercap/intel-rapl:0/energy_uj >/dev/null && echo "RAPL is readable."
