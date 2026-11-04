import { Controller, Delete, Get } from '@nestjs/common';

// Two controllers in one file: each endpoint belongs to the controller above it.
@Controller({ path: 'admin/reports', version: '1' })
export class ReportsController {
  @Get('sales')
  sales() {
    return { total: 0 };
  }
}

@Controller('admin/stats')
export class StatsController {
  @Get()
  overview() {
    return { orders: 0 };
  }

  @Delete('cache')
  clearCache() {
    return { cleared: true };
  }
}
