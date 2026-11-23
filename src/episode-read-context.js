(function (scope) {
  'use strict';
  function context(project, episodeNumber = project?.currentEpisode) {
    const episode = project?.episodes?.find(item => Number(item.number) === Number(episodeNumber));
    return {
      projectPath: project?.projectPath,
      currentEpisode: Number(episodeNumber),
      documentFormats: { ...(project?.documentFormats || {}) },
      activeFiles: { ...(project?.activeFiles || {}) },
      episodes: episode ? [{ number: episode.number, part: episode.part,
        activeFiles: { ...(episode.activeFiles || {}) } }] : []
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = context;
  scope.DirectorEpisodeReadContext = context;
})(typeof window !== 'undefined' ? window : globalThis);
