import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import type { Project } from './projects.models';
import { ProjectsService } from './projects.service';

const PROJECTS_URL = `${environment.apiBaseUrl}/projects`;

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });

  return {
    projects: TestBed.inject(ProjectsService),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

describe('ProjectsService', () => {
  it('uploads an image as multipart form data', () => {
    const { projects, httpMock } = setup();
    const file = new File(['image bytes'], 'cover.png', { type: 'image/png' });

    projects.uploadImage('p1', file).subscribe();

    const request = httpMock.expectOne(`${PROJECTS_URL}/p1/image`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toBeInstanceOf(FormData);
    const sent = (request.request.body as FormData).get('file') as File;
    expect(sent.name).toBe('cover.png');
    expect(sent.type).toBe('image/png');
    expect(sent.size).toBe(file.size);
  });

  it('removes an image', () => {
    const { projects, httpMock } = setup();

    projects.removeImage('p1').subscribe();

    const request = httpMock.expectOne(`${PROJECTS_URL}/p1/image`);
    expect(request.request.method).toBe('DELETE');
  });

  it('builds a stable image URL with updatedAt as the cache-busting version', () => {
    const { projects } = setup();
    const project = {
      id: 'p1',
      hasImage: true,
      updatedAt: '2026-10-02T08:00:00.000Z',
    };

    expect(projects.imageUrl(project)).toBe(
      `${PROJECTS_URL}/p1/image?v=${encodeURIComponent(project.updatedAt)}`,
    );
  });

  it('changes the image URL when the project is updated, so a replacement is fetched', () => {
    const { projects } = setup();
    const project = {
      id: 'p1',
      hasImage: true,
      updatedAt: '2026-10-02T08:00:00.000Z',
    };

    const before = projects.imageUrl(project);
    const after = projects.imageUrl({ ...project, updatedAt: '2026-10-03T08:00:00.000Z' });

    expect(after).not.toBe(before);
    expect(after).toContain('2026-10-03T08%3A00%3A00.000Z');
  });

  it('has no URL when the project stores no image', () => {
    const { projects } = setup();
    const project: Project = {
      id: 'p1',
      name: 'Compiler rewrite',
      description: null,
      hasImage: false,
      chatCount: 0,
      artifactCount: 0,
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-02T08:00:00.000Z',
    };

    expect(projects.imageUrl(project)).toBeNull();
    expect(projects.imageUrl(null)).toBeNull();
    expect(projects.imageUrl(undefined)).toBeNull();
  });
});
