import { Injectable, OnModuleInit } from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import axios from 'axios';

// Importar empresas.json como un array
const empresasData = require('../../empresas.json') as Empresa[];

interface Empresa {
  id: string;
  nombre: string;
  whatsapp: string;
  sesionPath: string;
}

@Injectable()
export class BotsService implements OnModuleInit {
  private bots = new Map<string, ReturnType<typeof makeWASocket>>();
  private connectionAttempts = new Map<string, number>();
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_INTERVAL = 5000; // 5 segundos
  private readonly CONNECTION_TIMEOUT = 60000; // 60 segundos

  async onModuleInit() {
    try {
      // Limpiar sesiones antiguas al iniciar
      await this.limpiarSesionesAntiguas();
      
      const empresas = await this.obtenerEmpresas();
      if (Array.isArray(empresas) && empresas.length > 0) {
        for (const empresa of empresas) {
          await this.iniciarBot(empresa);
        }
      } else {
        console.error('No se encontraron empresas para iniciar');
      }
    } catch (error) {
      console.error('Error al iniciar los bots:', error);
    }
  }

  private async limpiarSesionesAntiguas() {
    try {
      const sessionsDir = path.resolve(process.cwd(), 'sessions');
      if (fs.existsSync(sessionsDir)) {
        const empresas = await this.obtenerEmpresas();
        for (const empresa of empresas) {
          const empresaDir = path.join(sessionsDir, empresa.id);
          if (fs.existsSync(empresaDir)) {
            // Mantener solo los archivos de sesión más recientes
            const archivos = fs.readdirSync(empresaDir);
            const sesionesActivas = new Set<string>();
            
            // Mantener solo las últimas 10 sesiones por chat
            const sesionesPorChat = new Map<string, string[]>();
            
            archivos.forEach(archivo => {
              if (archivo.startsWith('session-')) {
                const [chatId] = archivo.split('.');
                if (!sesionesPorChat.has(chatId)) {
                  sesionesPorChat.set(chatId, []);
                }
                sesionesPorChat.get(chatId)?.push(archivo);
              }
            });

            // Mantener solo las últimas 10 sesiones por chat
            sesionesPorChat.forEach((sesiones, chatId) => {
              sesiones.sort().reverse().slice(0, 10).forEach(sesion => {
                sesionesActivas.add(sesion);
              });
            });

            // Eliminar archivos antiguos
            archivos.forEach(archivo => {
              if (archivo.startsWith('session-') && !sesionesActivas.has(archivo)) {
                fs.unlinkSync(path.join(empresaDir, archivo));
              }
            });
          }
        }
      }
    } catch (error) {
      console.error('Error al limpiar sesiones antiguas:', error);
    }
  }

  async obtenerEmpresas(): Promise<Empresa[]> {
    try {
      return empresasData;
    } catch (error) {
      console.error('Error al obtener empresas:', error);
      return [];
    }
  }

  private async esperar(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async iniciarBot(empresa: Empresa) {
    if (this.bots.has(empresa.id)) {
      console.log(`[${empresa.nombre}] Bot ya iniciado`);
      return;
    }

    try {
      const sesionDir = path.resolve(process.cwd(), 'sessions', empresa.id);
      if (!fs.existsSync(sesionDir)) {
        fs.mkdirSync(sesionDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sesionDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys)
        },
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
        connectTimeoutMs: this.CONNECTION_TIMEOUT,
        defaultQueryTimeoutMs: this.CONNECTION_TIMEOUT,
        retryRequestDelayMs: 250,
        markOnlineOnConnect: true,
        emitOwnEvents: true,
        syncFullHistory: false,
        getMessage: async () => {
          return { conversation: 'Hola' }
        },
        generateHighQualityLinkPreview: true,
        keepAliveIntervalMs: 30000,
        patchMessageBeforeSending: (message) => {
          const requiresPatch = !!(
            message.buttonsMessage 
            || message.templateMessage
            || message.listMessage
          );
          if (requiresPatch) {
            message = {
              viewOnceMessage: {
                message: {
                  messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                  },
                  ...message,
                },
              },
            };
          }
          return message;
        }
      });

      this.bots.set(empresa.id, sock);

      // Manejar eventos de conexión
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          console.log(`\n[${empresa.nombre}] Escanea el código QR para iniciar sesión:`);
          qrcode.generate(qr, { small: true });
          this.connectionAttempts.set(empresa.id, 0);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          const attempts = (this.connectionAttempts.get(empresa.id) || 0) + 1;
          
          console.log(`[${empresa.nombre}] Conexión cerrada debido a ${lastDisconnect?.error}, intento ${attempts} de ${this.MAX_RECONNECT_ATTEMPTS}`);
          
          if (shouldReconnect && attempts <= this.MAX_RECONNECT_ATTEMPTS) {
            this.connectionAttempts.set(empresa.id, attempts);
            const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
            console.log(`[${empresa.nombre}] Intentando reconectar en ${delay/1000} segundos...`);
            
            try {
              await this.esperar(delay);
              if (this.bots.has(empresa.id)) {
                const oldSock = this.bots.get(empresa.id);
                if (oldSock) {
                  oldSock.end(new Error('Reconexión iniciada'));
                  this.bots.delete(empresa.id);
                }
              }
              await this.iniciarBot(empresa);
            } catch (error) {
              console.error(`[${empresa.nombre}] Error durante la reconexión:`, error);
            }
          } else if (attempts > this.MAX_RECONNECT_ATTEMPTS) {
            console.error(`[${empresa.nombre}] Se alcanzó el máximo número de intentos de reconexión`);
            this.bots.delete(empresa.id);
            this.connectionAttempts.delete(empresa.id);
          }
        } else if (connection === 'open') {
          console.log(`[${empresa.nombre}] Bot conectado exitosamente`);
          this.connectionAttempts.delete(empresa.id);
        }
      });

      // Guardar credenciales cuando se actualicen
      sock.ev.on('creds.update', saveCreds);

      // Manejar mensajes
      sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        const texto = m.message?.conversation;
        const sender = m.key.remoteJid;

        //? Solo responder si el mensaje comienza con '!'

        if (!m.key.fromMe && texto && texto.startsWith('/')) {
          const comando = texto.slice(1).trim();
          // Comando de estado
          if (comando.startsWith('estado')) {
            const pedidoId = comando.split(' ')[1];
            try {
              const response = await axios.get(
                `http://localhost:3000/empresas/${empresa.id}/pedidos/${pedidoId}`,
              );
              const { estado } = response.data;

              await this.enviarMensaje(sock, sender, `📦 Estado del pedido ${pedidoId}: ${estado}`);
            } catch (e) {
              await this.enviarMensaje(sock, sender, `❌ No encontré el pedido ${pedidoId}`);
            }
          }
          // Comando de ayuda
          else if (comando.toLowerCase() === 'ayuda' || comando.toLowerCase() === 'help') {
            const mensajeAyuda = `🤖 *Comandos disponibles:*
• *!estado [número]* - Consulta el estado de un pedido
• *!ayuda* - Muestra este mensaje de ayuda
• *!info* - Muestra información de la tienda

Para más información, contacta a soporte.`;
            await this.enviarMensaje(sock, sender, mensajeAyuda);
          }
          // Comando de información
          else if (comando.toLowerCase() === 'info') {
            const mensajeInfo = `🏪 *${empresa.nombre}*
📱 WhatsApp: ${empresa.whatsapp}
⏰ Horario de atención: Lunes a Sábado de 9:00 a 18:00

¡Gracias por contactarnos! 😊`;
            await this.enviarMensaje(sock, sender, mensajeInfo);
          }
          // Mensaje por defecto para comandos desconocidos
          else {
            await this.enviarMensaje(sock, sender, `Comando no reconocido. Escribe *!ayuda* para ver los comandos disponibles.`);
          }
        }
      });

      console.log(`[${empresa.nombre}] Bot iniciado correctamente`);
    } catch (error) {
      console.error(`Error al iniciar bot para ${empresa.nombre}:`, error);
      const attempts = (this.connectionAttempts.get(empresa.id) || 0) + 1;
      if (attempts <= this.MAX_RECONNECT_ATTEMPTS) {
        this.connectionAttempts.set(empresa.id, attempts);
        console.log(`[${empresa.nombre}] Intentando reconectar después del error...`);
        await this.esperar(this.RECONNECT_INTERVAL);
        await this.iniciarBot(empresa);
      }
    }
  }

  private async enviarMensaje(sock: ReturnType<typeof makeWASocket>, to: string, text: string) {
    try {
      await sock.sendMessage(to, { text });
    } catch (error) {
      console.error('Error al enviar mensaje:', error);
    }
  }

  async enviarMensajePorEmpresaId(empresaId: string, to: string, text: string) {
    try {
      const sock = this.bots.get(empresaId);
      if (!sock) {
        throw new Error('Bot no encontrado');
      }
      await this.enviarMensaje(sock, to, text);
      return { success: true, message: 'Mensaje enviado correctamente' };
    } catch (error) {
      console.error('Error al enviar mensaje por empresa ID:', error);
      return { success: false, error: 'Error al enviar el mensaje' };
    }
  }

  async iniciarBotPorEmpresaId(empresaId: string) {
    try {
      const empresas = await this.obtenerEmpresas();
      const empresa = empresas.find(e => e.id === empresaId);

      if (!empresa) {
        return { error: 'Empresa no encontrada' };
      }

      await this.iniciarBot(empresa);
      return { message: `Bot iniciado para ${empresa.nombre}` };
    } catch (error) {
      console.error('Error al iniciar bot por empresa ID:', error);
      return { error: 'Error al iniciar el bot' };
    }
  }
}

