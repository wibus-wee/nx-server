import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  ServicesEnum,
  ServicePorts,
} from '~/shared/constants/services.constant';
import { getEnv } from '~/shared/utils/rag-env';
import { REDIS } from '../../app.config';
import { FriendsController } from './friends.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: ServicesEnum.friends,
        transport: Transport.REDIS,
        options: {
          port: REDIS.port,
          host: REDIS.host,
          password: REDIS.password,
          username: REDIS.user,
        },
      },
    ]),
  ],
  controllers: [FriendsController],
  providers: [],
  exports: [],
})
export class FriendsModule { }
