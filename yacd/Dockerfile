# Independent sidecar for the official Yacd static build. Keep the upstream
# commit in one place so deployment can pin the resulting image by digest.
FROM docker.io/library/nginx:alpine@sha256:fed7e14be83cbd2661a75cdc5b872d936cf155d46c327084d30b8df19ae88d72
ARG YACD_REVISION=84b49e987408ad65d6c951944facb8e4b55d0c41
RUN apk add --no-cache curl \
  && rm -rf /usr/share/nginx/html/* \
  && curl -fsSL --retry 5 --retry-all-errors --connect-timeout 10 --max-time 120 \
       "https://codeload.github.com/MetaCubeX/Yacd-meta/tar.gz/${YACD_REVISION}" \
       -o /tmp/yacd.tar.gz \
  && tar -xzf /tmp/yacd.tar.gz --strip-components=1 -C /usr/share/nginx/html \
  && rm /tmp/yacd.tar.gz \
  && sed 's|^user  nginx;|user  root;|; s|include /etc/nginx/conf.d/[*].conf;|include /tmp/yacd-server.conf;|' \
       /etc/nginx/nginx.conf > /tmp/nginx.conf \
  && printf '%s\n' 'server {' '  listen 9091; server_name _; root /usr/share/nginx/html;' \
       '  location / { try_files $uri $uri/ /index.html; }' \
       '  location ~ "/assets/.*[.](?:css|js|woff2?|svg|gif|map)$" { try_files $uri =404; add_header Cache-Control "public, max-age=31536000, immutable"; }' \
       '}' > /tmp/yacd-server.conf
USER 0:0
EXPOSE 9091
CMD ["nginx", "-g", "daemon off;", "-c", "/tmp/nginx.conf"]
