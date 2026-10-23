import { Module } from '@nestjs/common';

import { TypesenseModule } from '../typesense/typesense.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({
  imports: [TypesenseModule],
  controllers: [WorkspacesController, ProjectsController],
  providers: [WorkspacesService, ProjectsService],
})
export class WorkspacesModule {}
