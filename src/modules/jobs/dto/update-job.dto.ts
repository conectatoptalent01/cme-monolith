import { 
  IsArray, 
  IsIn, 
  IsNumber, 
  IsOptional, 
  IsPositive, 
  IsString 
} from 'class-validator';

export class UpdateJobDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsIn(['full-time', 'part-time', 'services-agreement', 'one-off', 'consulting'])
  @IsOptional()
  employmentType?: 'full-time' | 'part-time' | 'services-agreement' | 'one-off' | 'consulting';

  @IsIn(['remote', 'on_site', 'hybrid'])
  @IsOptional()
  locationType?: 'remote' | 'on_site' | 'hybrid';

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  skills?: string[];

  @IsString()
  @IsOptional()
  requirements?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsIn(['open', 'paused', 'closed'])
  @IsOptional()
  status?: 'open' | 'paused' | 'closed';

  @IsNumber()
  @IsPositive()
  @IsOptional()
  salary?: number;

  @IsString()
  @IsOptional()
  currency?: string;
}
