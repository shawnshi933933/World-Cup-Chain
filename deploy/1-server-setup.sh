#!/bin/bash
# ============================================================
# 第一步：服务器初始化（只需在新服务器上运行一次）
# 用法：bash 1-server-setup.sh
# ============================================================
set -e

echo ""
echo "======================================="
echo "  炜新世界杯 — 服务器初始化脚本"
echo "======================================="
echo ""

# 更新系统
echo ">>> 更新系统..."
sudo apt-get update -y && sudo apt-get upgrade -y

# 安装基础工具
echo ">>> 安装基础工具..."
sudo apt-get install -y curl git build-essential

# 安装 Node.js 20
echo ">>> 安装 Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v

# 安装 pnpm
echo ">>> 安装 pnpm..."
npm install -g pnpm
pnpm -v

# 安装 PM2（进程管理器，服务器重启后自动恢复）
echo ">>> 安装 PM2..."
npm install -g pm2

# 安装 nginx
echo ">>> 安装 nginx..."
sudo apt-get install -y nginx

# 安装 PostgreSQL
echo ">>> 安装 PostgreSQL..."
sudo apt-get install -y postgresql postgresql-contrib

# 创建数据库用户和数据库
echo ">>> 创建数据库..."
sudo -u postgres psql -c "CREATE USER worldcup WITH PASSWORD 'wc2026db';" 2>/dev/null || echo "（用户已存在，跳过）"
sudo -u postgres psql -c "CREATE DATABASE worldcup OWNER worldcup;" 2>/dev/null || echo "（数据库已存在，跳过）"

# 创建应用目录
echo ">>> 创建目录..."
sudo mkdir -p /opt/worldcup
sudo mkdir -p /var/www/worldcup
sudo mkdir -p /opt/worldcup/logs
sudo chown -R $USER:$USER /opt/worldcup
sudo chown -R $USER:$USER /var/www/worldcup

# 启动服务
echo ">>> 启动服务..."
sudo systemctl enable postgresql nginx
sudo systemctl start postgresql nginx

echo ""
echo "✅ 服务器初始化完成！"
echo ""
echo "下一步："
echo "  1. 把代码传到 /opt/worldcup/"
echo "  2. 在 /opt/worldcup/.env 中填写环境变量"
echo "  3. 运行 bash deploy/2-app-deploy.sh"
