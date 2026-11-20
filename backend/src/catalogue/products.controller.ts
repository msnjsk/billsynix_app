import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { MAX_IMAGE_BYTES, ProductsService } from './products.service.js';
import { ImportService, MAX_IMPORT_BYTES } from './import.service.js';
import {
  barcodeInput,
  createProductSchema,
  importQuery,
  listProductsQuery,
  lookupQuery,
  updateProductSchema,
  type BarcodeInput,
  type CreateProductInput,
  type ListProductsQuery,
  type LookupQuery,
  type UpdateProductInput,
} from './catalogue.schemas.js';

type UploadedBlob = { buffer: Buffer; size: number };

const fileBody = (field: string, description: string) => ({
  schema: {
    type: 'object',
    required: [field],
    properties: { [field]: { type: 'string', format: 'binary', description } },
  },
});

const storeQuery = z.object({ storeId: z.uuid().optional() });

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly importer: ImportService,
  ) {}

  /* Fixed paths first, so they aren't taken for a product id. */

  @Get('lookup')
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: 'Find the product for a scanned barcode or typed SKU',
    description:
      'Barcodes are matched before SKUs. `packQty` is how many units one scan sells. With `storeId`, `product.storePrice` is the price that branch bills at.',
  })
  lookup(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: lookupQuery }) q: LookupQuery,
  ) {
    return this.products.lookup(auth, q);
  }

  @Get('export')
  @RequirePermissions('products:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="products.csv"')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Whole catalogue as CSV (same columns the import takes)',
  })
  export(@CurrentAuth() auth: AuthContext) {
    return this.importer.export(auth);
  }

  @Get('import/template')
  @RequirePermissions('products:write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="products-template.csv"')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Empty import file with two example rows' })
  template() {
    return this.importer.template();
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('products:write')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody('file', 'CSV, UTF-8, up to 2 MB / 5000 products'))
  @ApiOperation({
    summary: 'Create or update products from CSV (all or nothing)',
    description:
      'Rows are matched by SKU. Every row is checked first; if any has a problem nothing is written and `errors` lists each one by row and column. `dryRun=true` only checks. Missing categories and brands are created.',
  })
  import(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: UploadedBlob | undefined,
    @Query({ schema: importQuery }) q: { dryRun: boolean },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.importer.importCsv(auth, file, q.dryRun, meta);
  }

  /* Collection */

  @Get()
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: 'Search and list products',
    description:
      '`q`: every word must match the name, the start of the SKU, or a whole barcode. `categoryId` includes subcategories. `parentId` lists the variants of a product.',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listProductsQuery }) q: ListProductsQuery,
  ) {
    return this.products.list(auth, q);
  }

  @Post()
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Create a product' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createProductSchema }) body: CreateProductInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.create(auth, body, meta);
  }

  /* One product */

  @Get(':productId')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'One product' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @Query({ schema: storeQuery }) q: { storeId?: string },
  ) {
    return this.products.get(auth, id, q.storeId);
  }

  @Patch(':productId')
  @RequirePermissions('products:write')
  @ApiOperation({
    summary: 'Edit a product',
    description:
      'Send `version` from your copy to be told (409) if someone changed it meanwhile.',
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @Body({ schema: updateProductSchema }) body: UpdateProductInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.update(auth, id, body, meta);
  }

  @Post(':productId/archive')
  @HttpCode(200)
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Archive (hide from billing; history is kept)' })
  archive(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.setStatus(auth, id, 'INACTIVE', meta);
  }

  @Post(':productId/restore')
  @HttpCode(200)
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Bring an archived product back' })
  restore(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.setStatus(auth, id, 'ACTIVE', meta);
  }

  @Post(':productId/barcodes')
  @RequirePermissions('products:write')
  @ApiOperation({
    summary: 'Add a barcode (e.g. a case barcode with packQty 12)',
  })
  addBarcode(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @Body({ schema: barcodeInput }) body: BarcodeInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.addBarcode(auth, id, body, meta);
  }

  @Delete(':productId/barcodes/:barcodeId')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Remove a barcode' })
  removeBarcode(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @Param('barcodeId', { schema: uuidParam }) barcodeId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.removeBarcode(auth, id, barcodeId, meta);
  }

  @Put(':productId/image')
  @RequirePermissions('products:write')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody('image', 'JPEG, PNG or WebP, up to 2 MB'))
  @ApiOperation({ summary: 'Set the product photo' })
  putImage(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @UploadedFile() file: UploadedBlob | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.putImage(auth, id, file, meta);
  }

  @Get(':productId/image')
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: 'The product photo',
    description:
      'The image bytes, or a redirect to a short-lived link when files are in S3.',
  })
  async getImage(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @Res() res: Response,
  ) {
    const found = await this.products.getImage(auth, id);
    if (found.kind === 'redirect') {
      res.redirect(302, found.url);
      return;
    }
    res
      .status(200)
      .set({
        'Content-Type': found.contentType,
        'Cache-Control': 'private, max-age=300',
        'Content-Security-Policy': "default-src 'none'",
      })
      .send(found.body);
  }

  @Delete(':productId/image')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Remove the product photo' })
  deleteImage(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.products.deleteImage(auth, id, meta);
  }
}
