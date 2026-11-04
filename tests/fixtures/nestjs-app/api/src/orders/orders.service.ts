import { Injectable } from '@nestjs/common';

@Injectable()
export class OrdersService {
  private readonly all: { id: string; items: string[]; shipped: boolean }[] = [];

  findAll() {
    return [...this.all].reverse();
  }

  findOne(id: string) {
    return this.all.find((o) => o.id === id);
  }

  create(items: string[]) {
    const order = { id: String(this.all.length + 1), items, shipped: false };
    this.all.push(order);
    return order;
  }

  ship(id: string) {
    const order = this.findOne(id);
    if (order) order.shipped = true;
    return order;
  }
}
