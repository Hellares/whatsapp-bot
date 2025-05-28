import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(BotsService.name);
  private bots = new Map<string, ReturnType<typeof makeWASocket>>();
  private connectionAttempts = new Map<string, number>();
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_INTERVAL = 5000;
  private readonly CONNECTION_TIMEOUT = 60000;
  private readonly N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_BASE || 'http://n8n-server:5678/webhook';

  async onModuleInit() {
    try {
      await this.limpiarSesionesAntiguas();
      
      const empresas = await this.obtenerEmpresas();
      if (Array.isArray(empresas) && empresas.length > 0) {
        for (const empresa of empresas) {
          await this.iniciarBot(empresa);
        }
      } else {
        this.logger.error('No se encontraron empresas para iniciar');
      }
    } catch (error) {
      this.logger.error('Error al iniciar los bots:', error);
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
            const archivos = fs.readdirSync(empresaDir);
            const sesionesActivas = new Set<string>();
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

            sesionesPorChat.forEach((sesiones, chatId) => {
              sesiones.sort().reverse().slice(0, 10).forEach(sesion => {
                sesionesActivas.add(sesion);
              });
            });

            archivos.forEach(archivo => {
              if (archivo.startsWith('session-') && !sesionesActivas.has(archivo)) {
                fs.unlinkSync(path.join(empresaDir, archivo));
              }
            });
          }
        }
      }
    } catch (error) {
      this.logger.error('Error al limpiar sesiones antiguas:', error);
    }
  }

  async obtenerEmpresas(): Promise<Empresa[]> {
    try {
      return empresasData;
    } catch (error) {
      this.logger.error('Error al obtener empresas:', error);
      return [];
    }
  }

  private async esperar(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Nuevo método: Enviar mensaje a N8N
  private async enviarMensajeAN8N(empresaId: string, data: {
    mensaje: string;
    telefono: string;
    empresaId: string;
    timestamp: number;
  }): Promise<void> {
    try {
      const webhookUrl = `${this.N8N_WEBHOOK_URL}/empresa-${empresaId}`;
      
      this.logger.debug(`Enviando mensaje a N8N: ${webhookUrl}`);
      
      const response = await axios.post(webhookUrl, data, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Bot-Service'
        }
      });

      this.logger.log(`Mensaje enviado a N8N exitosamente para empresa ${empresaId}`);
      
    } catch (error) {
      this.logger.error(`Error enviando mensaje a N8N para empresa ${empresaId}:`, error.message);
      
      // Fallback: Si N8N no está disponible, procesar localmente
      await this.procesarMensajeLocal(empresaId, data);
    }
  }

  // Método fallback para procesar mensajes localmente
  private async procesarMensajeLocal(empresaId: string, data: {
    mensaje: string;
    telefono: string;
    empresaId: string;
  }): Promise<void> {
    const sock = this.bots.get(empresaId);
    if (!sock) return;

    const { mensaje, telefono } = data;
    
    if (mensaje.startsWith('!')) {
      const comando = mensaje.slice(1).trim().toLowerCase();
      
      let respuesta = '';
      
      if (comando === 'ayuda' || comando === 'help') {
        respuesta = `🤖 *Comandos disponibles (Modo local):*
• *!estado [número]* - Consulta el estado de un pedido
• *!ayuda* - Muestra este mensaje
• *!info* - Información de la tienda
• *!horario* - Horarios de atención

*Nota:* N8N no disponible, funcionando en modo local.`;
      } else if (comando === 'info') {
        const empresa = empresasData.find(e => e.id === empresaId);
        respuesta = `🏪 *${empresa?.nombre || 'Empresa'}*
📱 WhatsApp: ${empresa?.whatsapp || 'No disponible'}

¡Gracias por contactarnos! 😊`;
      } else {
        respuesta = `❓ Comando no reconocido. Escribe *!ayuda* para ver comandos disponibles.
        
*Nota:* Sistema funcionando en modo local.`;
      }
      
      await this.enviarMensaje(sock, telefono, respuesta);
    }
  }

  async iniciarBot(empresa: Empresa) {
    if (this.bots.has(empresa.id)) {
      this.logger.log(`[${empresa.nombre}] Bot ya iniciado`);
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
          this.logger.log(`\n[${empresa.nombre}] Escanea el código QR para iniciar sesión:`);
          qrcode.generate(qr, { small: true });
          this.connectionAttempts.set(empresa.id, 0);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          const attempts = (this.connectionAttempts.get(empresa.id) || 0) + 1;
          
          this.logger.log(`[${empresa.nombre}] Conexión cerrada debido a ${lastDisconnect?.error}, intento ${attempts} de ${this.MAX_RECONNECT_ATTEMPTS}`);
          
          if (shouldReconnect && attempts <= this.MAX_RECONNECT_ATTEMPTS) {
            this.connectionAttempts.set(empresa.id, attempts);
            const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
            this.logger.log(`[${empresa.nombre}] Intentando reconectar en ${delay/1000} segundos...`);
            
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
              this.logger.error(`[${empresa.nombre}] Error durante la reconexión:`, error);
            }
          } else if (attempts > this.MAX_RECONNECT_ATTEMPTS) {
            this.logger.error(`[${empresa.nombre}] Se alcanzó el máximo número de intentos de reconexión`);
            this.bots.delete(empresa.id);
            this.connectionAttempts.delete(empresa.id);
          }
        } else if (connection === 'open') {
          this.logger.log(`[${empresa.nombre}] Bot conectado exitosamente`);
          this.connectionAttempts.delete(empresa.id);
        }
      });

      // Guardar credenciales cuando se actualicen
      sock.ev.on('creds.update', saveCreds);

      // NUEVO: Manejar mensajes - Enviar a N8N
      sock.ev.on('messages.upsert', async (msg) => {
        const m = msg.messages[0];
        const texto = m.message?.conversation;
        const sender = m.key.remoteJid;

        // Solo procesar mensajes que no sean nuestros
        if (!m.key.fromMe && texto) {
          this.logger.debug(`[${empresa.nombre}] Mensaje recibido de ${sender}: ${texto}`);
          
          try {
            // Enviar a N8N para procesamiento
            await this.enviarMensajeAN8N(empresa.id, {
              mensaje: texto,
              telefono: sender,
              empresaId: empresa.id,
              timestamp: Date.now()
            });
          } catch (error) {
            this.logger.error(`[${empresa.nombre}] Error procesando mensaje:`, error);
          }
        }
      });

      this.logger.log(`[${empresa.nombre}] Bot iniciado correctamente`);
    } catch (error) {
      this.logger.error(`Error al iniciar bot para ${empresa.nombre}:`, error);
      const attempts = (this.connectionAttempts.get(empresa.id) || 0) + 1;
      if (attempts <= this.MAX_RECONNECT_ATTEMPTS) {
        this.connectionAttempts.set(empresa.id, attempts);
        this.logger.log(`[${empresa.nombre}] Intentando reconectar después del error...`);
        await this.esperar(this.RECONNECT_INTERVAL);
        await this.iniciarBot(empresa);
      }
    }
  }

  private async enviarMensaje(sock: ReturnType<typeof makeWASocket>, to: string, text: string) {
    try {
      await sock.sendMessage(to, { text });
      this.logger.debug(`Mensaje enviado a ${to}`);
    } catch (error) {
      this.logger.error('Error al enviar mensaje:', error);
    }
  }

  // NUEVO: Método para que N8N envíe respuestas al bot
  async enviarRespuestaDesdeN8N(empresaId: string, telefono: string, respuesta: string): Promise<{ success: boolean; message: string }> {
    try {
      const sock = this.bots.get(empresaId);
      if (!sock) {
        throw new Error(`Bot no encontrado para empresa ${empresaId}`);
      }

      await this.enviarMensaje(sock, telefono, respuesta);
      
      this.logger.log(`[${empresaId}] Respuesta de N8N enviada a ${telefono}`);
      
      return { 
        success: true, 
        message: 'Respuesta enviada correctamente desde N8N' 
      };
    } catch (error) {
      this.logger.error(`Error enviando respuesta desde N8N:`, error);
      return { 
        success: false, 
        message: error.message 
      };
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
      this.logger.error('Error al enviar mensaje por empresa ID:', error);
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
      this.logger.error('Error al iniciar bot por empresa ID:', error);
      return { error: 'Error al iniciar el bot' };
    }
  }

  // NUEVO: Método para obtener estado del bot
  obtenerEstadoBot(empresaId: string) {
    const botExiste = this.bots.has(empresaId);
    const intentosReconexion = this.connectionAttempts.get(empresaId) || 0;
    
    return {
      empresaId,
      activo: botExiste,
      intentosReconexion,
      timestamp: new Date().toISOString()
    };
  }
}