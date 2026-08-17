import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ClientsService, CreateClientDto, UpdateClientDto } from './clients.service';
import { Roles } from '../auth/roles.decorator';

@Roles('admin')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list() {
    return this.clients.list();
  }

  @Post()
  create(@Body() body: Partial<CreateClientDto>) {
    // Χωρίς server και χωρίς πλάνα: ο πελάτης είναι σκέτο όνομα μέχρι να
    // αγοράσει (δες POST /clients/:id/subscriptions).
    if (!body.name) throw new BadRequestException('name απαιτείται');
    return this.clients.create(body as CreateClientDto);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.clients.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateClientDto) {
    return this.clients.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.clients.remove(id);
  }

  @Post(':id/subscriptions')
  addSubscription(@Param('id', ParseIntPipe) id: number, @Body() body: { planId?: number }) {
    if (!body.planId) throw new BadRequestException('planId απαιτείται');
    return this.clients.addSubscription(id, body.planId);
  }

  @Patch(':id/subscriptions/:subId')
  setSubscription(
    @Param('id', ParseIntPipe) id: number,
    @Param('subId', ParseIntPipe) subId: number,
    @Body() body: { disabled?: boolean },
  ) {
    if (typeof body.disabled !== 'boolean') throw new BadRequestException('disabled (boolean) απαιτείται');
    return this.clients.setSubscriptionDisabled(id, subId, body.disabled);
  }

  @Delete(':id/subscriptions/:subId')
  removeSubscription(@Param('id', ParseIntPipe) id: number, @Param('subId', ParseIntPipe) subId: number) {
    return this.clients.removeSubscription(id, subId);
  }

  @Post(':id/paths')
  addPath(@Param('id', ParseIntPipe) id: number, @Body() body: { path?: string; subscriptionId?: number }) {
    // Ο stream server συγκρίνει το session.streamPath ΑΚΡΙΒΩΣ με το κλειδί του
    // clients.json. Ένα "live/kamera1" χωρίς αρχική κάθετο, ή με query/κενά,
    // δεν θα ταίριαζε ποτέ — και η αποτυχία θα φαινόταν μόνο ως «άκυρο κλειδί»
    // στα logs του server, ώρες αργότερα.
    // Χωρίς path το φτιάχνει το service από τα ids — δες nextPath().
    if (body.path && !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.path)) {
      throw new BadRequestException('path της μορφής /app/stream (π.χ. /live/kamera1)');
    }
    // Το path ανήκει σε συνδρομή, όχι στον πελάτη: από εκεί βγαίνει ο server και
    // το όριο θεατών του.
    if (!body.subscriptionId) throw new BadRequestException('subscriptionId απαιτείται');
    return this.clients.addPath(id, body.path, body.subscriptionId);
  }

  @Post(':id/paths/:pathId/key')
  refreshKey(@Param('id', ParseIntPipe) id: number, @Param('pathId', ParseIntPipe) pathId: number) {
    return this.clients.refreshKey(id, pathId);
  }

  @Delete(':id/paths/:pathId')
  removePath(@Param('id', ParseIntPipe) id: number, @Param('pathId', ParseIntPipe) pathId: number) {
    return this.clients.removePath(id, pathId);
  }
}
