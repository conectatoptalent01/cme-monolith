import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, ParseUUIDPipe, ForbiddenException,
} from '@nestjs/common';
import { PaymentServiceService } from './payment-service.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { QueryPaymentsDto } from './dto/query-payments.dto';
import { StartReferralCheckoutDto } from './dto/start-hire-checkout.dto';
import { AuthUser } from '../../common/auth/auth-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { AccessService } from '../../common/auth/access.service';

@Controller('payments')
export class PaymentServiceController {
  constructor(
    private readonly service: PaymentServiceService,
    private readonly access: AccessService,
  ) { }

  /** Crear, editar o borrar pagos a mano: solo administradores de CME. */
  @Post()
  async create(@AuthUser() user: any, @Body() dto: CreatePaymentDto) {
    await this.access.assertAdmin(user);
    return this.service.create(dto);
  }

  @Get()
  async list(@Query() q: QueryPaymentsDto, @AuthUser() user: any) {
    const limit = Math.max(1, Math.min(100, Number(q.limit ?? 20)));
    const offset = Math.max(0, Number(q.offset ?? 0));
    const query: QueryPaymentsDto = { ...q, limit, offset };
    const isAdmin = await this.access.isAdmin(user);

    const mineFlag =
      (typeof q.mine === 'string' ? q.mine === 'true' : !!q.mine) ||
      (!q.companyId && !q.headhunterId);

    if (mineFlag) {
      return this.service.listMine({
        meCompanyId: user?.companyId ?? null,
        meHeadhunterId: this.access.userId(user),
        query,
        tryResolveCompanyFromAdmin: true,
      });
    }

    if (!isAdmin) {
      // filtros explícitos: solo sobre la propia empresa o sobre uno mismo como reclutador
      if (q.headhunterId && q.headhunterId !== this.access.userId(user)) {
        throw new ForbiddenException('not_allowed_for_other_user');
      }
      if (q.companyId) await this.access.assertCompanyAdmin(user, q.companyId);
    }

    return this.service.list(query);
  }

  @Get(':id')
  async findOne(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    const payment = await this.service.findOne(id);
    await this.access.assertPaymentParty(user, payment);
    return payment;
  }

  @Get(':id/receipt')
  async receipt(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertPaymentParty(user, await this.service.findOne(id));
    return this.service.getReceiptData(id);
  }

  @Patch(':id')
  async update(
    @AuthUser() user: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() patch: UpdatePaymentDto,
  ) {
    await this.access.assertAdmin(user);
    return this.service.update(id, patch);
  }

  @Delete(':id')
  async remove(@AuthUser() user: any, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.access.assertAdmin(user);
    return this.service.remove(id);
  }

  /** Solo la empresa dueña de la vacante inicia el cobro de la contratación. */
  @Post('referral/checkout')
  async startReferralCheckout(@AuthUser() user: any, @Body() dto: StartReferralCheckoutDto) {
    const ctx = await this.access.referralContext(dto.referralId);
    await this.access.assertCompanyAdmin(user, ctx.company_id);
    return this.service.startReferralCheckout(dto);
  }

  @Public()
  @Post('webhook')
  async mpWebhook(@Body() body: any, @Query() query: any, @Query('pid') pid: string) {
    return this.service.handleMercadoPagoWebhook(body, query, pid);
  }
}
