import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID
} from 'class-validator';

export class CreateJobDto {
  @IsUUID()
  @IsNotEmpty()
  companyId!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsIn(['full-time', 'part-time', 'services-agreement', 'one-off', 'consulting'])
  employmentType!: 'full-time' | 'part-time' | 'services-agreement' | 'one-off' | 'consulting';

  @IsString()
  @IsIn(['remote', 'on_site', 'hybrid'])
  locationType!: 'remote' | 'on_site' | 'hybrid';

  @IsString()
  @IsOptional()
  requirements?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  skills?: string[];

  /**
   * Monto de la posición. Obligatorio: con él se calcula el fee de contratación
   * (ver src/modules/payments/fee-schedule.ts).
   */
  @IsNumber()
  @IsPositive()
  salary!: number;

  @IsString()
  @IsOptional()
  currency?: string;
}
