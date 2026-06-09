#!/bin/bash
# ============================================================
# 第二步：构建并启动应用（每次更新代码后运行）
# 用法：在 /opt/worldcup 目录下运行：bash deploy/2-app-deploy.sh
# ============================================================
set -e

APP_DIR="/opt/worldcup"
WEB_DIR="/var/www/worldcup"

echo ""
echo "======================================="
echo "  炜新世界杯 — 部署脚本"
echo "======================================="
echo ""

# 检查 .env 文件
if [ ! -f "$APP_DIR/.env" ]; then
  echo "❌ 未找到 $APP_DIR/.env 文件！"
  echo "   请先复制并填写：cp deploy/.env.template .env"
  exit 1
fi

# 加载环境变量
export $(grep -v '^#' $APP_DIR/.env | xargs)

cd $APP_DIR

echo ">>> 安装依赖..."
pnpm install

echo ">>> 初始化/更新数据库..."
pnpm --filter @workspace/db run push --accept-data-loss

echo ">>> 构建 API 服务器..."
pnpm --filter @workspace/api-server run build

echo ">>> 构建前端..."
PORT=3000 BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/world-cup run build

echo ">>> 部署前端静态文件..."
sudo rm -rf $WEB_DIR/*
sudo cp -r $APP_DIR/artifacts/world-cup/dist/public/* $WEB_DIR/

echo ">>> 配置 nginx..."
sudo cp $APP_DIR/deploy/nginx.conf /etc/nginx/sites-available/worldcup
sudo ln -sf /etc/nginx/sites-available/worldcup /etc/nginx/sites-enabled/worldcup
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo ">>> 启动/重启 API 服务..."
pm2 start $APP_DIR/deploy/pm2.config.cjs --env production 2>/dev/null || \
  pm2 restart worldcup-api
pm2 save

# 设置开机自启
pm2 startup systemd -u $USER --hp $HOME 2>/dev/null | grep "sudo" | bash 2>/dev/null || true

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || echo "你的服务器IP")

echo ""
echo "✅ 部署完成！"
echo ""
echo "   网站地址：http://$SERVER_IP"
echo "   API 地址：http://$SERVER_IP/api"
echo ""
echo "查看运行状态：pm2 status"
echo "查看日志：    pm2 logs worldcup-api"
