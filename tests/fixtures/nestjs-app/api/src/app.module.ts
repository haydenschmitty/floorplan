import { Module } from '@nestjs/common';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { ProductsController, CouponsController } from './catalog/catalog.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [OrdersController, ProductsController, CouponsController, HealthController],
  providers: [OrdersService],
})
export class AppModule {}
