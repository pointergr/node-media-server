import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global ώστε κάθε module (auth, servers, clients, sync, me) να το παίρνει
// χωρίς να το ξαναδηλώνει — μία μόνο σύνδεση σε όλη την εφαρμογή.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
