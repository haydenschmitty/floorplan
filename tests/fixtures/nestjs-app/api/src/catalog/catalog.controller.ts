import { Controller, Delete, Get } from '@nestjs/common';

// Two controllers in one file: each endpoint belongs to the controller above it.
@Controller({ path: 'catalog/products', version: '1' })
export class ProductsController {
  @Get('featured')
  featured() {
    return [];
  }
}

@Controller('catalog/coupons')
export class CouponsController {
  @Get()
  list() {
    return [];
  }

  @Delete('expired')
  clearExpired() {
    return { removed: 0 };
  }
}
