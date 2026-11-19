import { IsOptional, IsString, IsInt, Min, IsIn, IsArray, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class QuerySearchJobsDto {
  @IsOptional() @IsString()
  q?: string;

  @IsOptional() @IsString()
  employmentType?: 'full-time'|'part-time'|'services-agreement'|'one-off'|'consulting';

  @IsOptional() @IsString()
  locationType?: 'remote'|'on_site'|'hybrid';

  @IsOptional() @IsString()
  location?: string;

  @IsOptional() @Type(() => Number) @IsNumber()
  minSalary?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  maxSalary?: number;

  @IsOptional() @IsArray()
  @Type(() => String)
  skillsAny?: string[];

  @IsOptional() @IsArray()
  @Type(() => String)
  skillsAll?: string[];

  @IsOptional() @IsString()
  companyId?: string;

  @IsOptional() @IsString()
  status?: 'open'|'paused'|'closed';

  @IsOptional() @IsInt() @Type(() => Number) @Min(1)
  limit: number = 20;

  @IsOptional() @IsInt() @Type(() => Number) @Min(0)
  offset: number = 0;

  @IsOptional() @IsIn(['newest','oldest','salary_desc','salary_asc'])
  orderBy: 'newest'|'oldest'|'salary_desc'|'salary_asc' = 'newest';
}
