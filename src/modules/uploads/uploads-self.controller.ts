import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadsService } from './uploads-service.service';
import { AuthUser } from 'src/common/auth/auth-user.decorator';
import { AccessService } from 'src/common/auth/access.service';

/**
 * Antes el usuario se tomaba de las cabeceras x-user-id / x-internal-gateway, que cualquiera
 * podía falsificar para cambiar la foto de otra persona. Ahora sale del token verificado.
 */

@Controller('uploads/self')
export class UploadsSelfController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly access: AccessService,
  ) { }

  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, 
    }),
  )
  async uploadAvatarOneShot(@AuthUser() user: any, @UploadedFile() file: any) {
    return this.uploads.uploadAvatarOneShot(this.access.userId(user), file);
  }

  @Post('cover')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async uploadCoverOneShot(@AuthUser() user: any, @UploadedFile() file: any) {
    return this.uploads.uploadCoverOneShot(this.access.userId(user), file);
  }
}
