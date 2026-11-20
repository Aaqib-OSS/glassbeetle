import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from './api-base';
import { toHttpParams } from './http-params';
import type { PaginatedResponse } from './pagination';
import type {
  CreateProjectInput,
  Project,
  ProjectListQuery,
  UpdateProjectInput,
} from './projects.models';

/** `/api/v1/projects` — the folders chats and artifacts are filed under. */
@Injectable({ providedIn: 'root' })
export class ProjectsService extends ApiClient {
  list(query: ProjectListQuery = {}): Observable<PaginatedResponse<Project>> {
    return this.http.get<PaginatedResponse<Project>>(this.url('/projects'), {
      params: toHttpParams({ ...query }),
    });
  }

  get(projectId: string): Observable<Project> {
    return this.http.get<Project>(this.url(`/projects/${projectId}`));
  }

  create(input: CreateProjectInput): Observable<Project> {
    return this.http.post<Project>(this.url('/projects'), input);
  }

  update(projectId: string, input: UpdateProjectInput): Observable<Project> {
    return this.http.patch<Project>(this.url(`/projects/${projectId}`), input);
  }

  /**
   * Deletes the project.
   *
   * Its chats and artifacts are kept and become unfiled: the foreign keys are
   * cleared rather than cascaded, so removing a folder never removes work.
   */
  remove(projectId: string): Observable<void> {
    return this.http.delete<void>(this.url(`/projects/${projectId}`));
  }

  /**
   * Replaces the project's image (`PUT`, so it is idempotent).
   *
   * The server accepts any single multipart field name; `file` is used here.
   * JPEG, PNG, WebP and GIF are permitted — SVG is rejected server-side to
   * keep stored XSS out of the Tauri webview.
   */
  uploadImage(projectId: string, file: File): Observable<Project> {
    const body = new FormData();
    body.append('file', file, file.name);

    return this.http.put<Project>(this.url(`/projects/${projectId}/image`), body);
  }

  /** Idempotent: removing an image from a project that has none still succeeds. */
  removeImage(projectId: string): Observable<void> {
    return this.http.delete<void>(this.url(`/projects/${projectId}/image`));
  }

  /**
   * Stable download URL for a project's image, or `null` when none is stored.
   *
   * The endpoint serves one stable URL and revalidates with an `ETag`, so
   * `updatedAt` is carried as a query parameter: it changes the URL the
   * moment the image is replaced, which is what makes the new image appear
   * without waiting for a conditional request to come back.
   */
  imageUrl(
    project: { id: string; hasImage: boolean; updatedAt: string } | null | undefined,
  ): string | null {
    if (!project?.hasImage) {
      return null;
    }

    return this.url(`/projects/${project.id}/image?v=${encodeURIComponent(project.updatedAt)}`);
  }
}
