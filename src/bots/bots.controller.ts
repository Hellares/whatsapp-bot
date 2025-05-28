import { Controller, Get, Post, Param, Body, HttpStatus, HttpException, Logger } from '@nestjs/common';
import { BotsService } from './bots.service';

@Controller('bots')
export class BotsController {
  private readonly logger = new Logger(BotsController.name);

  constructor(private readonly botsService: BotsService) {}

  @Get('health')
  healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };
  }

  @Get(':empresaId/start')
  async iniciarBot(@Param('empresaId') empresaId: string) {
    this.logger.log(`Iniciando bot para empresa: ${empresaId}`);
    return this.botsService.iniciarBotPorEmpresaId(empresaId);
  }

  @Get(':empresaId/status')
  async obtenerEstadoBot(@Param('empresaId') empresaId: string) {
    this.logger.log(`Consultando estado del bot para empresa: ${empresaId}`);
    return this.botsService.obtenerEstadoBot(empresaId);
  }

  // NUEVO: Endpoint para recibir respuestas de N8N
  @Post('webhook/respuesta')
  async recibirRespuestaDeN8N(@Body() body: {
    empresaId: string;
    telefono: string;
    respuesta: string;
  }) {
    try {
      this.logger.log(`Recibiendo respuesta de N8N para empresa ${body.empresaId}`);

      // Validar datos requeridos
      if (!body.empresaId || !body.telefono || !body.respuesta) {
        throw new HttpException(
          'Datos requeridos: empresaId, telefono, respuesta',
          HttpStatus.BAD_REQUEST
        );
      }

      const resultado = await this.botsService.enviarRespuestaDesdeN8N(
        body.empresaId,
        body.telefono,
        body.respuesta
      );
      
      if (!resultado.success) {
        throw new HttpException(
          resultado.message,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      return {
        success: true,
        message: 'Respuesta enviada correctamente',
        data: {
          empresaId: body.empresaId,
          telefono: body.telefono,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      this.logger.error('Error procesando respuesta de N8N:', error);
      
      if (error instanceof HttpException) {
        throw error;
      }
      
      throw new HttpException(
        'Error interno del servidor',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // NUEVO: Endpoint para enviar mensajes directamente (útil para testing)
  @Post(':empresaId/send')
  async enviarMensaje(
    @Param('empresaId') empresaId: string,
    @Body() body: {
      telefono: string;
      mensaje: string;
    }
  ) {
    try {
      this.logger.log(`Enviando mensaje directo para empresa ${empresaId}`);

      if (!body.telefono || !body.mensaje) {
        throw new HttpException(
          'Datos requeridos: telefono, mensaje',
          HttpStatus.BAD_REQUEST
        );
      }

      const resultado = await this.botsService.enviarMensajePorEmpresaId(
        empresaId,
        body.telefono,
        body.mensaje
      );

      if (!resultado.success) {
        throw new HttpException(
          resultado.error || 'Error al enviar mensaje',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      return {
        success: true,
        message: 'Mensaje enviado correctamente',
        data: {
          empresaId,
          telefono: body.telefono,
          mensaje: body.mensaje,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      this.logger.error('Error enviando mensaje directo:', error);
      
      if (error instanceof HttpException) {
        throw error;
      }
      
      throw new HttpException(
        'Error interno del servidor',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // NUEVO: Endpoint para obtener información de todas las empresas
  @Get('empresas')
  async listarEmpresas() {
    try {
      const empresas = await this.botsService.obtenerEmpresas();
      
      return {
        success: true,
        data: empresas.map(empresa => ({
          id: empresa.id,
          nombre: empresa.nombre,
          whatsapp: empresa.whatsapp,
          // No incluir sesionPath por seguridad
        })),
        total: empresas.length
      };
    } catch (error) {
      this.logger.error('Error obteniendo lista de empresas:', error);
      
      throw new HttpException(
        'Error obteniendo empresas',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // NUEVO: Endpoint para obtener estado de todos los bots
  @Get('status/all')
  async obtenerEstadoTodosBots() {
    try {
      const empresas = await this.botsService.obtenerEmpresas();
      
      const estados = empresas.map(empresa => 
        this.botsService.obtenerEstadoBot(empresa.id)
      );

      return {
        success: true,
        data: estados,
        timestamp: new Date().toISOString(),
        resumen: {
          total: estados.length,
          activos: estados.filter(e => e.activo).length,
          inactivos: estados.filter(e => !e.activo).length
        }
      };
    } catch (error) {
      this.logger.error('Error obteniendo estado de todos los bots:', error);
      
      throw new HttpException(
        'Error obteniendo estado de bots',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}