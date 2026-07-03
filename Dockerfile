# 无第三方依赖，单阶段即可
FROM node:20-alpine

WORKDIR /app

# 只复制运行所需文件（密钥不在其中，靠环境变量注入）
COPY server.js totp.js config.js auth.js ./
COPY public ./public

# 容器内监听 0.0.0.0，对外隔离靠宿主机端口映射到 127.0.0.1
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

# 以非 root 用户运行
USER node

# 简易健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
