import { Module } from '@nestjs/common';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { ReportsController, StatsController } from './admin/admin.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [OrdersController, ReportsController, StatsController, HealthController],
  providers: [OrdersService],
})
export class AppModule {}
