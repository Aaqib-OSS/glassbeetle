import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { environment } from '../../../../environments/environment';
import type { Project } from '../../../core/api/projects.models';
import { ProjectsService } from '../../../core/api/projects.service';
import { NotificationService } from '../../../core/notifications/notification.service';
import { AgentRosterService } from '../../../core/workspace/agent-roster.service';
import { ConversationsService } from '../../../core/workspace/conversations.service';
import { ProjectDetail } from './project-detail';

const DETAIL_URL = `${environment.apiBaseUrl}/projects/p1`;
const IMAGE_URL = `${DETAIL_URL}/image`;
const CHATS_URL = `${environment.apiBaseUrl}/chats`;
const ARTIFACTS_URL = `${environment.apiBaseUrl}/artifacts`;

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Compiler rewrite',
    description: 'IR passes and the new backend.',
    hasImage: false,
    chatCount: 0,
    artifactCount: 0,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
    ...overrides,
  };
}

function page() {
  return { items: [], total: 0, limit: 50, offset: 0 };
}

function choose(file: File): Event {
  const input = document.createElement('input');
  Object.defineProperty(input, 'files', { value: [file] });
  return { target: input } as unknown as Event;
}

interface DetailInternals {
  onImageSelected(event: Event): Promise<void>;
  removeImage(): Promise<void>;
}

function setup(current: Project = project()) {
  const notify = { success: vi.fn(), error: vi.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ProjectDetail],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: NotificationService, useValue: notify },
      { provide: AgentRosterService, useValue: { agents: signal([]) } },
      {
        provide: ConversationsService,
        useValue: { teamName: () => null, refresh: vi.fn(), refreshProjects: vi.fn() },
      },
      { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(true) }) } },
    ],
  });

  const httpMock = TestBed.inject(HttpTestingController);
  const projects = TestBed.inject(ProjectsService);
  const fixture = TestBed.createComponent(ProjectDetail);
  fixture.componentRef.setInput('projectId', 'p1');
  fixture.detectChanges();

  httpMock.expectOne(DETAIL_URL).flush(current);
  httpMock.expectOne((request) => request.url === CHATS_URL).flush(page());
  httpMock.expectOne((request) => request.url === ARTIFACTS_URL).flush(page());
  fixture.detectChanges();

  return {
    fixture,
    element: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance as unknown as DetailInternals,
    httpMock,
    notify,
    projects,
  };
}

describe('ProjectDetail', () => {
  it('draws the stored image in the header', () => {
    const stored = project({ hasImage: true });
    const { element, projects } = setup(stored);

    expect(element.querySelector('.head__identity img')?.getAttribute('src')).toBe(
      projects.imageUrl(stored),
    );
  });

  it('falls back to initials when the project has no image', () => {
    const { element } = setup();

    expect(element.querySelector('.head__identity img')).toBeNull();
    expect(element.querySelector('.head__identity')?.textContent).toContain('CR');
  });

  it('accepts only the image types the server stores', () => {
    const { element } = setup();

    expect(element.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe(
      'image/jpeg,image/png,image/webp,image/gif',
    );
  });

  it('uploads a replacement and asks for the new image at its new URL', async () => {
    const stored = project({ hasImage: true });
    const updated = project({
      hasImage: true,
      updatedAt: '2026-10-03T08:00:00.000Z',
    });
    const { element, component, httpMock, projects, fixture } = setup(stored);
    const file = new File(['image bytes'], 'cover.png', { type: 'image/png' });

    const pending = component.onImageSelected(choose(file));
    const request = httpMock.expectOne(IMAGE_URL);
    expect(request.request.method).toBe('PUT');
    const sent = (request.request.body as FormData).get('file') as File;
    expect(sent.name).toBe('cover.png');
    expect(sent.type).toBe('image/png');
    expect(sent.size).toBe(file.size);
    request.flush(updated);
    await pending;
    fixture.detectChanges();

    expect(element.querySelector('.head__identity img')?.getAttribute('src')).toBe(
      projects.imageUrl(updated),
    );
    expect(projects.imageUrl(updated)).not.toBe(projects.imageUrl(stored));
  });

  it('rejects an SVG before it is sent', async () => {
    const { component, httpMock, notify } = setup();
    const file = new File(['<svg />'], 'cover.svg', { type: 'image/svg+xml' });

    await component.onImageSelected(choose(file));

    httpMock.expectNone(IMAGE_URL);
    expect(notify.error).toHaveBeenCalledWith(
      null,
      'Images must be JPEG, PNG, WebP or GIF. SVG is not accepted.',
    );
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('reports a rejected upload and keeps the previous image', async () => {
    const stored = project({ hasImage: true });
    const { element, component, httpMock, notify, projects, fixture } = setup(stored);
    const file = new File(['not really a png'], 'cover.png', { type: 'image/png' });

    const pending = component.onImageSelected(choose(file));
    httpMock.expectOne(IMAGE_URL).flush(
      {
        statusCode: 415,
        error: 'Unsupported Media Type',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'The file content is not a permitted image type.',
      },
      { status: 415, statusText: 'Unsupported Media Type' },
    );
    await pending;
    fixture.detectChanges();

    expect(notify.error).toHaveBeenCalledWith(expect.anything(), 'Could not upload the image.');
    expect(notify.success).not.toHaveBeenCalled();
    expect(element.querySelector('.head__identity img')?.getAttribute('src')).toBe(
      projects.imageUrl(stored),
    );
  });

  it('reports an oversized upload', async () => {
    const { component, httpMock, notify } = setup();
    const file = new File(['too large'], 'cover.png', { type: 'image/png' });

    const pending = component.onImageSelected(choose(file));
    httpMock.expectOne(IMAGE_URL).flush(
      {
        statusCode: 413,
        error: 'Payload Too Large',
        code: 'PICTURE_TOO_LARGE',
        message: 'The image is larger than the configured maximum.',
      },
      { status: 413, statusText: 'Payload Too Large' },
    );
    await pending;

    expect(notify.error).toHaveBeenCalledWith(expect.anything(), 'Could not upload the image.');
  });

  it('removes the image and falls back to initials', async () => {
    const stored = project({ hasImage: true });
    const { element, component, httpMock, notify, fixture } = setup(stored);

    const pending = component.removeImage();
    const request = httpMock.expectOne(IMAGE_URL);
    expect(request.request.method).toBe('DELETE');
    request.flush(null);
    await pending;
    fixture.detectChanges();

    expect(notify.success).toHaveBeenCalledWith('Image removed.');
    expect(element.querySelector('.head__identity img')).toBeNull();
    expect(element.querySelector('.head__identity')?.textContent).toContain('CR');
  });

  it('reports a failed removal and keeps the image', async () => {
    const stored = project({ hasImage: true });
    const { element, component, httpMock, notify, projects, fixture } = setup(stored);

    const pending = component.removeImage();
    httpMock.expectOne(IMAGE_URL).flush(
      {
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message: 'The image could not be removed.',
      },
      { status: 500, statusText: 'Internal Server Error' },
    );
    await pending;
    fixture.detectChanges();

    expect(notify.error).toHaveBeenCalledWith(expect.anything(), 'Could not remove the image.');
    expect(notify.success).not.toHaveBeenCalled();
    expect(element.querySelector('.head__identity img')?.getAttribute('src')).toBe(
      projects.imageUrl(stored),
    );
  });
});
