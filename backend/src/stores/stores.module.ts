import { Module } from '@nestjs/common';
import { CountersController, StoresController } from './stores.controller.js';
import { StoresService } from './stores.service.js';

@Module({
  controllers: [StoresController, CountersController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
