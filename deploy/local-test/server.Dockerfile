# "VM" de teste: Debian 12 com o mesmo que o setup-server.sh instala para a
# aplicação — sshd endurecido, Node 22, PM2 e o usuário deploy.
# Fora daqui: UFW, Fail2Ban e Certbot (precisam de systemd/iptables/IP público).
FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server curl ca-certificates \
      rsync build-essential python3 gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pm2 \
 && rm -rf /var/lib/apt/lists/*

COPY ssh/00-hardening.conf /etc/ssh/sshd_config.d/00-hardening.conf

RUN adduser --disabled-password --gecos "" deploy \
 && install -d -m 700 -o deploy -g deploy /home/deploy/.ssh \
 && install -d -m 750 -o deploy -g deploy /opt/memo-pill /opt/memo-pill/data \
 && mkdir -p /run/sshd

CMD ["/usr/sbin/sshd", "-D", "-e"]
