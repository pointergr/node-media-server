import { Module } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';

@Module({
  providers: [ClientsService],
  controllers: [ClientsController],
  // Το /me ανανεώνει κλειδί με την ίδια συνάρτηση (refreshKey) — δεύτερο αντίγραφο
  // θα ήταν δεύτερος έλεγχος ιδιοκτησίας που μπορεί να ξεχαστεί.
  exports: [ClientsService],
})
export class ClientsModule {}
