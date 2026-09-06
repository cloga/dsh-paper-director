window.__ModuleLoader__.load({ id: 'dsh-paper-director', factory: (require) => {
  'use strict'
  var React = require('react')
  return {
    inject: ['slots'],
    apply: function (ctx) {
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action', id: 'paper-director-link', order: 10,
        }, function PaperDirectorLink(props) {
          return React.createElement('a', {
            href: '/paper-director/', title: '纸上小导演', 'aria-label': '打开纸上小导演创作室',
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', color: 'inherit', textDecoration: 'none', borderRadius: '8px' },
          }, React.createElement('span', { 'aria-hidden': true }, '🎬'), props.wide ? '纸上小导演' : null)
        })
      })
    },
  }
} })
