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
  Query,
} from '@nestjs/common';
import { cleanLabel, ClientsService, CreateClientDto, UpdateClientDto } from './clients.service';
import { DestinationDto } from './destinations';
import { Roles } from '../auth/roles.decorator';

@Roles('admin')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list(@Query('username') username?: string) {
    return this.clients.list(username);
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
    @Body() body: { disabled?: boolean; label?: string | null; planId?: number },
  ) {
    // Τα τρία πεδία είναι ανεξάρτητα (αναστολή χωρίς να πειραχτεί το όνομα και
    // αντίστροφα), αλλά άδειο σώμα είναι λάθος του caller και όχι no-op: θα
    // επέστρεφε 200 χωρίς να έχει αλλάξει τίποτα.
    const data: { disabled?: boolean; label?: string | null; planId?: number } = {};
    if ('disabled' in body) {
      if (typeof body.disabled !== 'boolean') throw new BadRequestException('disabled: boolean');
      data.disabled = body.disabled;
    }
    if ('label' in body) data.label = cleanLabel(body.label);
    if ('planId' in body) {
      if (typeof body.planId !== 'number') throw new BadRequestException('planId: number');
      data.planId = body.planId;
    }
    if (!Object.keys(data).length) throw new BadRequestException('disabled, label ή planId απαιτείται');
    return this.clients.updateSubscription(id, subId, data);
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

  // Οι εξωτερικοί προορισμοί του stream (YouTube κ.λπ.). Τα ίδια τρία endpoints
  // υπάρχουν και στο /me: ο πελάτης βάζει μόνος του το κανάλι του, ο admin
  // μπορεί να το κάνει γι' αυτόν στο τηλέφωνο. Ο έλεγχος εγκυρότητας και το
  // όριο του πλάνου ζουν στο service, μία φορά για τους δύο δρόμους.
  @Post(':id/paths/:pathId/destinations')
  addDestination(
    @Param('id', ParseIntPipe) id: number,
    @Param('pathId', ParseIntPipe) pathId: number,
    @Body() body: Partial<DestinationDto>,
  ) {
    return this.clients.addDestination(id, pathId, body);
  }

  @Patch(':id/paths/:pathId/destinations/:destId')
  setDestination(
    @Param('id', ParseIntPipe) id: number,
    @Param('pathId', ParseIntPipe) pathId: number,
    @Param('destId', ParseIntPipe) destId: number,
    @Body() body: Partial<DestinationDto>,
  ) {
    return this.clients.updateDestination(id, pathId, destId, body);
  }

  @Delete(':id/paths/:pathId/destinations/:destId')
  removeDestination(
    @Param('id', ParseIntPipe) id: number,
    @Param('pathId', ParseIntPipe) pathId: number,
    @Param('destId', ParseIntPipe) destId: number,
  ) {
    return this.clients.removeDestination(id, pathId, destId);
  }
}
