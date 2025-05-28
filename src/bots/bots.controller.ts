import { Controller, Get, Param } from '@nestjs/common';
import { BotsService } from './bots.service';

@Controller('bots')
export class BotsController {
  constructor(private readonly botsService: BotsService) {}

  @Get(':empresaId/start')
  async iniciarBot(@Param('empresaId') empresaId: string) {
    return this.botsService.iniciarBotPorEmpresaId(empresaId);
  }
}
