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
    // Χωρίς server: τον δίνουν τα πακέτα που θα αγοράσει (δες schema.prisma).
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

  @Post(':id/paths')
  addPath(@Param('id', ParseIntPipe) id: number, @Body() body: { path?: string; serverId?: number }) {
    // Ο stream server συγκρίνει το session.streamPath ΑΚΡΙΒΩΣ με το κλειδί του
    // clients.json. Ένα "live/kamera1" χωρίς αρχική κάθετο, ή με query/κενά,
    // δεν θα ταίριαζε ποτέ — και η αποτυχία θα φαινόταν μόνο ως «άκυρο κλειδί»
    // στα logs του server, ώρες αργότερα.
    if (!body.path || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.path)) {
      throw new BadRequestException('path της μορφής /app/stream (π.χ. /live/kamera1)');
    }
    // Το path ζει σε συγκεκριμένο μηχάνημα — ο πελάτης μπορεί να έχει αγορές σε
    // περισσότερα από ένα, οπότε δεν υπάρχει «προφανής» server να μαντέψουμε.
    if (!body.serverId) throw new BadRequestException('serverId απαιτείται');
    return this.clients.addPath(id, body.path, body.serverId);
  }

  @Delete(':id/paths/:pathId')
  removePath(@Param('id', ParseIntPipe) id: number, @Param('pathId', ParseIntPipe) pathId: number) {
    return this.clients.removePath(id, pathId);
  }
}
