import { Module } from '@nestjs/common';
import { TaxonomyController } from './taxonomy.controller.js';
import { ProductsController } from './products.controller.js';
import { PriceListsController } from './price-lists.controller.js';
import { TaxonomyService } from './taxonomy.service.js';
import { ProductsService } from './products.service.js';
import { PriceListsService } from './price-lists.service.js';
import { ImportService } from './import.service.js';

/** Products, barcodes, categories, brands, units, tax rates and branch pricing (Phase 4). */
@Module({
  controllers: [TaxonomyController, ProductsController, PriceListsController],
  providers: [
    TaxonomyService,
    ProductsService,
    PriceListsService,
    ImportService,
  ],
  exports: [ProductsService, ImportService, TaxonomyService],
})
export class CatalogueModule {}
