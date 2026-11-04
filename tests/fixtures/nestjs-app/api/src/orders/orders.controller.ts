import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Every order, newest first. */
  @Get()
  findAll() {
    return this.orders.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orders.findOne(id);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  create(@Body() body: { items: string[] }) {
    return this.orders.create(body.items);
  }

  @Patch(':id/ship')
  async ship(@Param('id') id: string) {
    return this.orders.ship(id);
  }
}
