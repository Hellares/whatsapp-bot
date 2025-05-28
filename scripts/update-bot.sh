#!/bin/bash

# Script para actualizar el bot desde GitHub
# Ejecutar como: ./update-bot.sh [BRANCH]

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BRANCH=${1:-"main"}
PROJECT_DIR="/opt/whatsapp-bot"

echo -e "${BLUE}🔄 Actualizando Bot de WhatsApp...${NC}"

# Verificar si el directorio existe
if [ ! -d "$PROJECT_DIR" ]; then
    echo -e "${RED}❌ Directorio del proyecto no encontrado: $PROJECT_DIR${NC}"
    echo -e "${YELLOW}Ejecuta deploy-from-github.sh primero${NC}"
    exit 1
fi

cd "$PROJECT_DIR"

# Verificar si es un repositorio git
if [ ! -d ".git" ]; then
    echo -e "${RED}❌ No es un repositorio Git${NC}"
    exit 1
fi

# Guardar cambios locales si los hay
echo -e "${YELLOW}💾 Guardando cambios locales...${NC}"
git stash push -m "Auto-stash before update $(date)"

# Actualizar desde GitHub
echo -e "${YELLOW}📥 Descargando actualizaciones...${NC}"
git fetch origin

# Cambiar a la rama especificada
echo -e "${YELLOW}🔀 Cambiando a rama: $BRANCH${NC}"
git checkout "$BRANCH"

# Hacer pull de los cambios
echo -e "${YELLOW}⬇️ Aplicando actualizaciones...${NC}"
git pull origin "$BRANCH"

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error al obtener actualizaciones${NC}"
    exit 1
fi

# Mostrar los cambios
echo -e "${BLUE}📝 Últimos cambios:${NC}"
git log --oneline -5

# Verificar si hay cambios en package.json
if git diff HEAD~1 --name-only | grep -q "package.json"; then
    echo -e "${YELLOW}📦 package.json modificado, será necesario reconstruir...${NC}"
    REBUILD=true
else
    REBUILD=false
fi

# Reconstruir si es necesario
if [ "$REBUILD" = true ]; then
    echo -e "${YELLOW}🔨 Reconstruyendo imagen Docker...${NC}"
    docker-compose -f docker-compose-bot.yml build --no-cache
else
    echo -e "${YELLOW}🔨 Reconstruyendo imagen Docker (incremental)...${NC}"
    docker-compose -f docker-compose-bot.yml build
fi

# Reiniciar el servicio
echo -e "${YELLOW}🔄 Reiniciando bot...${NC}"
docker-compose -f docker-compose-bot.yml down
docker-compose -f docker-compose-bot.yml up -d

# Esperar a que esté listo
echo -e "${YELLOW}⏳ Esperando a que el bot esté listo...${NC}"
sleep 10

# Verificar estado
echo -e "${YELLOW}📊 Verificando estado...${NC}"
docker-compose -f docker-compose-bot.yml ps

# Health check
echo -e "${YELLOW}🩺 Verificando salud del bot...${NC}"
sleep 5
if curl -f http://localhost:3034/health &>/dev/null; then
    echo -e "${GREEN}✅ Bot funcionando correctamente${NC}"
else
    echo -e "${RED}❌ El bot no responde en el health check${NC}"
    echo -e "${YELLOW}📜 Logs del bot:${NC}"
    docker-compose -f docker-compose-bot.yml logs --tail=20
fi

echo -e "${GREEN}✅ Actualización completada${NC}"
echo -e "${BLUE}📋 Información:${NC}"
echo -e "   Rama actual: $(git branch --show-current)"
echo -e "   Último commit: $(git log --oneline -1)"
echo -e "   Ver logs: docker-compose -f docker-compose-bot.yml logs -f"
