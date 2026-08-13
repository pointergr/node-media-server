import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SyncModule } from './sync/sync.module';
import { ServersModule } from './servers/servers.module';
import { ClientsModule } from './clients/clients.module';
import { MeModule } from './me/me.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';

@Module({
  imports: [PrismaModule, AuthModule, SyncModule, ServersModule, ClientsModule, MeModule],
  providers: [
    // Σειρά σκόπιμη: πρώτα authentication (JWT ή @Public), μετά authorization
    // (@Roles) — το RolesGuard διαβάζει το req.user που έγραψε το προηγούμενο.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
