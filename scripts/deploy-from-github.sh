#!/bin/bash

# Script para clonar y desplegar el bot desde GitHub
# Uso: ./deploy-from-github.sh [URL_REPO] [BRANCH]

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Variables
REPO_URL=${1:-""}
BRANCH=${2:-"main"}
PROJECT_DIR="/opt/whatsapp-bot"
BACKUP_DIR="/opt/whatsapp-bot-backup-$(date +%Y%m%d_%H%M%S)"

echo -e "${BLUE}🚀 Desplegando Bot de WhatsApp desde GitHub...${NC}"

# Verificar parámetros
if [ -z "$REPO_URL" ]; then
    echo -e "${RED}❌ URL del repositorio requerida${NC}"
    echo -e "${YELLOW}Uso: $0 <URL_REPO> [BRANCH]${NC}"
    echo -e "${YELLOW}Ejemplo: $0 https://github.com/usuario/whatsapp-bot.git main${NC}"
    exit 1
fi

# Verificar si Git está instalado
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}📦 Instalando Git...${NC}"
    apt-get update && apt-get install -y git
fi

# Backup del proyecto existente si existe
if [ -d "$PROJECT_DIR" ]; then
    echo -e "${YELLOW}💾 Creando backup del proyecto actual...${NC}"
    mv "$PROJECT_DIR" "$BACKUP_DIR"
    echo -e "${GREEN}✅ Backup creado en: $BACKUP_DIR${NC}"
fi

# Clonar el repositorio
echo -e "${YELLOW}📥 Clonando repositorio...${NC}"
git clone -b "$BRANCH" "$REPO_URL" "$PROJECT_DIR"

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error al clonar el repositorio${NC}"
    
    # Restaurar backup si existe
    if [ -d "$BACKUP_DIR" ]; then
        echo -e "${YELLOW}🔄 Restaurando backup...${NC}"
        mv "$BACKUP_DIR" "$PROJECT_DIR"
    fi
    exit 1
fi

cd "$PROJECT_DIR"

# Verificar archivos necesarios
echo -e "${YELLOW}🔍 Verificando archivos necesarios...${NC}"
REQUIRED_FILES=("package.json" "src" "empresas.json")

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -e "$file" ]; then
        echo -e "${RED}❌ Archivo/directorio faltante: $file${NC}"
        exit 1
    fi
done

# Crear Dockerfile si no existe
if [ ! -f "Dockerfile" ]; then
    echo -e "${YELLOW}📝 Creando Dockerfile...${NC}"
    cat > Dockerfile << 'EOF'
FROM node:18-alpine

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    udev \
    xvfb

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN addgroup -g 1001 -S nodejs && \
    adduser -S whatsapp -u 1001 -G nodejs

WORKDIR /app
RUN chown -R whatsapp:nodejs /app
USER whatsapp

COPY --chown=whatsapp:nodejs package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --chown=whatsapp:nodejs . .
RUN npm run build

RUN mkdir -p /app/sessions && chmod 755 /app/sessions
RUN mkdir -p /app/logs

EXPOSE 3034

ENV NODE_ENV=production
ENV PORT=3034

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3034/health || exit 1

CMD ["npm", "run", "start:prod"]
EOF
fi

# Crear docker-compose si no existe
if [ ! -f "docker-compose-bot.yml" ]; then
    echo -e "${YELLOW}📝 Creando docker-compose-bot.yml...${NC}"
    cat > docker-compose-bot.yml << 'EOF'
version: '3.8'

services:
  whatsapp-bot:
    build: 
      context: .
      dockerfile: Dockerfile
    container_name: whatsapp-bot
    ports:
      - "3034:3034"
    environment:
      - NODE_ENV=production
      - PORT=3034
      - N8N_WEBHOOK_URL=http://n8n-server:5678
      - N8N_WEBHOOK_BASE=http://86.48.26.221:5678/webhook
      - LOG_LEVEL=info
      - TZ=America/Lima
    
    volumes:
      - whatsapp_sessions:/app/sessions
      - whatsapp_logs:/app/logs
      - ./empresas.json:/app/empresas.json:ro
    
    networks:
      - elastika-network
    
    restart: unless-stopped
    
    depends_on:
      - n8n-server
    
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3034/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
        reservations:
          memory: 256M
          cpus: '0.25'

volumes:
  whatsapp_sessions:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/whatsapp-bot/sessions
      
  whatsapp_logs:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/whatsapp-bot/logs

networks:
  elastika-network:
    external: true
EOF
fi

# Crear .dockerignore si no existe
if [ ! -f ".dockerignore" ]; then
    echo -e "${YELLOW}📝 Creando .dockerignore...${NC}"
    cat > .dockerignore << 'EOF'
node_modules
npm-debug.log*
sessions/*
!sessions/.gitkeep
logs
*.log
.env.local
.env.development
.DS_Store
Thumbs.db
.git
.gitignore
Dockerfile
docker-compose*.yml
.dockerignore
.vscode
.idea
*.swp
*.swo
tmp
temp
.tmp
test
*.test.js
*.spec.js
dist
build
README.md
docs
EOF
fi

# Crear directorios necesarios
echo -e "${YELLOW}📁 Creando directorios necesarios...${NC}"
sudo mkdir -p /opt/whatsapp-bot/sessions
sudo mkdir -p /opt/whatsapp-bot/logs
sudo mkdir -p /opt/whatsapp-bot/backups

# Configurar permisos
echo -e "${YELLOW}🔐 Configurando permisos...${NC}"
sudo chown -R 1001:1001 /opt/whatsapp-bot/
sudo chmod -R 755 /opt/whatsapp-bot/

# Verificar dependencias
echo -e "${YELLOW}🔍 Verificando dependencias...${NC}"

# Verificar red
if ! docker network ls | grep -q elastika-network; then
    echo -e "${YELLOW}🌐 Creando red elastika-network...${NC}"
    docker network create elastika-network
fi

# Verificar N8N
if ! docker ps | grep -q n8n-server; then
    echo -e "${YELLOW}⚠️ N8N no está corriendo. El bot funcionará pero sin integración N8N.${NC}"
fi

# Construir imagen
echo -e "${YELLOW}🔨 Construyendo imagen Docker...${NC}"
docker-compose -f docker-compose-bot.yml build

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error al construir la imagen${NC}"
    exit 1
fi

# Detener contenedor existente
if docker ps | grep -q whatsapp-bot; then
    echo -e "${YELLOW}⏹️ Deteniendo bot existente...${NC}"
    docker-compose -f docker-compose-bot.yml down
fi

# Iniciar el bot
echo -e "${YELLOW}🚀 Iniciando bot de WhatsApp...${NC}"
docker-compose -f docker-compose-bot.yml up -d

# Esperar y verificar
echo -e "${YELLOW}⏳ Esperando a que el bot esté listo...${NC}"
sleep 15

# Mostrar estado
echo -e "${YELLOW}📊 Estado del despliegue:${NC}"
docker-compose -f docker-compose-bot.yml ps

# Mostrar logs
echo -e "${YELLOW}📜 Logs del bot:${NC}"
docker-compose -f docker-compose-bot.yml logs --tail=30

echo -e "${GREEN}✅ Despliegue desde GitHub completado${NC}"
echo -e "${BLUE}📋 Comandos útiles:${NC}"
echo -e "   Ver logs: docker-compose -f docker-compose-bot.yml logs -f"
echo -e "   Reiniciar: docker-compose -f docker-compose-bot.yml restart"
echo -e "   Actualizar: git pull && docker-compose -f docker-compose-bot.yml up -d --build"
echo -e ""
echo -e "${YELLOW}🔗 URLs:${NC}"
echo -e "   Bot Health: curl http://86.48.26.221:3034/health"
echo -e "   N8N Panel: http://86.48.26.221:5678"
