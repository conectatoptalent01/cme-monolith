import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller('healthz')
export class HealthController {
  constructor(  ) { }

  @Public()
  @Get()
  ok() {
    return { ok: true, ts: Date.now() };
  }

}
