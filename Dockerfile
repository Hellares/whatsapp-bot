FROM node:20-alpine

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

# Instalar todas las dependencias (incluye devDependencies para compilar)
RUN npm ci && npm cache clean --force

COPY --chown=whatsapp:nodejs . .

# Compilar TypeScript
RUN npm run build

# Limpiar devDependencies después de compilar
RUN npm prune --production

RUN mkdir -p /app/sessions && chmod 755 /app/sessions
RUN mkdir -p /app/logs

EXPOSE 3034

ENV NODE_ENV=production
ENV PORT=3034

CMD ["npm", "run", "start:prod"]
